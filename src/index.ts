import express from 'express';
import cors from 'cors';
import Bull from 'bull';
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { logger } from './utils/logger';
import migrationRoutes from './routes/migrations';
import bicomRoutes from './routes/bicom';
import vodiaRoutes from './routes/vodia';
import threecxRoutes from './routes/threecx';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Environment variables
const PORT = parseInt(process.env.PORT || '3000');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
}

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Initialize Redis (in-memory, same container)
export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

// Initialize Supabase
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Create Bull queue (uses local Redis)
export const migrationQueue = new Bull('migrations', {
  redis: {
    host: REDIS_HOST,
    port: REDIS_PORT,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 86400, // Keep for 24 hours
      count: 1000,
    },
    removeOnFail: {
      age: 86400,
      count: 100,
    },
  },
});

// Import processors
import { discoveryProcessor } from './processors/discovery';
import { mailSyncProcessor } from './processors/mail-sync';
import { calendarSyncProcessor } from './processors/calendar-sync';
import { catchupProcessor } from './processors/catchup';
import { bicomMigrationProcessor } from './processors/bicom-migration';

// Register processors with concurrency limits
migrationQueue.process('discovery', 1, discoveryProcessor);
migrationQueue.process('mail-sync', 5, mailSyncProcessor);
migrationQueue.process('calendar-sync', 5, calendarSyncProcessor);
migrationQueue.process('catchup', 2, catchupProcessor);
migrationQueue.process('bicom-migration', 2, bicomMigrationProcessor);

// Event handlers
migrationQueue.on('completed', (job) => {
  logger.info(`✅ Job ${job.id} completed`, {
    jobId: job.id,
    type: job.name,
    duration: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
  });
});

migrationQueue.on('failed', (job, err) => {
  logger.error(`❌ Job ${job?.id} failed`, {
    jobId: job?.id,
    type: job?.name,
    error: err.message,
    stack: err.stack,
  });
});

migrationQueue.on('progress', (job, progress) => {
  logger.debug(`📊 Job ${job.id} progress: ${progress}%`);
});

migrationQueue.on('error', (error) => {
  logger.error('Queue error:', error);
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      migrationQueue.getWaitingCount(),
      migrationQueue.getActiveCount(),
      migrationQueue.getCompletedCount(),
      migrationQueue.getFailedCount(),
    ]);

    res.json({
      status: 'healthy',
      redis: redis.status,
      queue: { waiting, active, completed, failed },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Migration routes
app.use('/migrations', migrationRoutes);
app.use('/bicom', bicomRoutes);
app.use('/vodia', vodiaRoutes);
app.use('/threecx', threecxRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Express error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
  });
});

// Start server
async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    logger.info('✅ Connected to Redis', { host: REDIS_HOST, port: REDIS_PORT });

    // Test Supabase connection
    const { error } = await supabase.from('migration_jobs').select('id').limit(1);
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Supabase connection failed: ${error.message}`);
    }
    logger.info('✅ Connected to Supabase');

    // Start Express server (bind to 0.0.0.0 for Railway)
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Migration worker listening on port ${PORT}`);
      logger.info(`📡 Health check: http://0.0.0.0:${PORT}/health`);
      logger.info(`🔄 Endpoints: POST /migrations/start, GET /migrations/:id/status`);
    });
  } catch (error) {
    logger.error('❌ Failed to start worker:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('⏳ SIGTERM received, shutting down gracefully...');
  
  await migrationQueue.close();
  await redis.quit();
  
  logger.info('✅ Shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('⏳ SIGINT received, shutting down gracefully...');
  
  await migrationQueue.close();
  await redis.quit();
  
  logger.info('✅ Shutdown complete');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
start();
