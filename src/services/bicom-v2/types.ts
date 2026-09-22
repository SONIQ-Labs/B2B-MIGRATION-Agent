/**
 * bicom-v2/types.ts
 *
 * In-memory shape of a Bicom tenant after parsing its pbxware_XXX.sql.gz dump.
 * These are the canonical intermediate representations we work with — the
 * mapper transforms them into SONIQ entities.
 */

export type BicomKVRow = {
  ext: string
  name: string
  value: string
}

/**
 * Bicom auto-attendant (IVR).
 *
 * The `aa` table is a key/value store keyed by (ext, name). We collapse all
 * rows sharing the same `ext` into one BicomIVR, promoting the well-known
 * keys to typed fields and keeping the digit-branches ("1", "2", "0", etc.)
 * as a separate map.
 */
export interface BicomIVR {
  ext: string                             // the IVR extension, e.g. "5000"
  name?: string                           // human name: "Main", "Divert", "Xmas"
  aasound?: string                        // greeting audio filename (no ext), e.g. "greeting-jul-24-2025-16-01-34"
  aatype?: string                         // 0 = standard, 1 = tree, etc.
  status?: string                         // "1" = enabled
  aarings?: string                        // rings before answer
  aaloop?: string                         // number of times to loop the menu
  aadt?: string                           // dial timeout
  aart?: string                           // response timeout
  rtpdelay?: string
  aaring?: string                         // ring sound preset
  aastatus?: string
  aaoperator?: string                     // operator extension (0 key fallback)
  aaoperator_vm?: string                  // "1" = also route 0 to VM
  aa_ot_greeting?: string                 // out-of-hours greeting audio
  skip_invalid_selection?: string
  digits: Record<string, string>          // "1" -> "rg::3000::::::::::::::::::"
  otime_id?: string                       // link into open_times if present
}

/** Bicom ring group. Structure varies but always has an ext, name, and members list. */
export interface BicomRingGroup {
  ext: string                             // group ext, e.g. "3000"
  name?: string
  strategy?: string                       // ringall | linear | random | ...
  timeout?: string                        // seconds
  members: string[]                       // extensions in ring order
  raw: Record<string, string>             // everything else from the key/value store
  no_answer?: string                      // Bicom destination string on timeout ("vm::2001::", "aa::5001::", "hangup::")
  otime_id?: string
}

/** Bicom queue. Same aa-style kv shape but under `queues` table. */
export interface BicomQueue {
  ext: string
  name?: string
  strategy?: string                       // ringall | leastrecent | fewestcalls | random | rrmemory
  timeout?: string                        // ring timeout per agent
  wrapuptime?: string
  maxlen?: string                         // max queue length
  music_class?: string                    // MOH class
  agents: string[]                        // list of agent extensions
  raw: Record<string, string>
  no_answer?: string                      // full-queue overflow destination
  otime_id?: string
}

/** Bicom DID (DDI) — inbound number → routing. */
export interface BicomDID {
  did: string                             // the E.164 (or Bicom-native) number
  destination?: string                    // Bicom destination string
  name?: string
  otime_id?: string
  extra: Record<string, string>
}

/** Bicom opening-time definition — reusable schedule referenced by IVRs/RGs/queues/DIDs. */
export interface BicomOtime {
  id: string
  name?: string
  timezone?: string
  rules: BicomOtimeRule[]                 // one or more time windows
  destinations: BicomOtimeDest[]          // "in-hours" and "out-of-hours" routes
}

export interface BicomOtimeRule {
  days: number[]                          // 0=Sun..6=Sat, ISO-8601 style
  start: string                           // "HH:MM"
  end: string                             // "HH:MM"
  months?: number[]                       // for holiday windows
  mdays?: number[]                        // month days
}

export interface BicomOtimeDest {
  in_hours: boolean                       // true = active during rule, false = out-of-hours
  destination: string                     // Bicom dest string
}

/** Bicom voicemail box (standalone — not tied to a user ext). Rare; usually implicit. */
export interface BicomVMBox {
  ext: string                             // the mailbox ext number
  name?: string
  email?: string
  greeting?: string                       // custom greeting filename
}

/** Bicom extension user (from ext table). Existing mapper already handles this — kept for completeness. */
export interface BicomExt {
  ext: string
  name?: string
  first_name?: string
  last_name?: string
  email?: string
  cli?: string                            // outbound CLI (per-user)
  password?: string                       // SIP password
  raw: Record<string, string>
}

/** Everything we parse out of one tenant's pbxware_XXX.sql.gz. */
export interface BicomTenant {
  tenant_code: string                     // "216"
  tenant_name?: string                    // pulled from `config` table

  extensions: Map<string, BicomExt>       // ext-number -> user
  ivrs: Map<string, BicomIVR>             // ext-number -> IVR
  ring_groups: Map<string, BicomRingGroup>
  queues: Map<string, BicomQueue>
  dids: BicomDID[]
  vm_boxes: Map<string, BicomVMBox>       // standalone VM ext -> box; user VM is implicit
  otimes: Map<string, BicomOtime>         // id -> Otime

  moh_classes: string[]                   // moh class names configured
  raw_tables: Map<string, BicomKVRow[]>   // fallback: every kv row we didn't promote — for later gap fills
}

/* ============================================================================
 * Resolved destination — the typed form of a Bicom "rg::3000::..." string,
 * after we've mapped the target ext to a concrete SONIQ entity.
 * ============================================================================ */

export type ResolvedDest =
  | { kind: 'ring_group';   ext: string; soniq_ring_group_id?: string; soniq_flow_id?: string }
  | { kind: 'ivr';          ext: string; soniq_flow_id?: string }
  | { kind: 'queue';        ext: string; soniq_queue_id?: string; soniq_flow_id?: string }
  | { kind: 'extension';    ext: string; soniq_user_id?: string }
  | { kind: 'voicemail_user';  ext: string; soniq_user_id?: string }
  | { kind: 'voicemail_group'; ext: string; soniq_group_id?: string; soniq_queue_id?: string }
  | { kind: 'hangup' }
  | { kind: 'operator' }
  | { kind: 'external';     number: string }
  | { kind: 'unknown';      raw: string }
