/**
 * bicom-v2/client.ts
 *
 * Complete typed client for the Bicom PBXware MT API.
 * Every endpoint we use for migration is here with proper input/output types.
 *
 * The Bicom API convention:
 *  - GET /index.php?apikey=KEY&action=pbxware.X.Y&server=TENANT_SERVER_ID
 *  - Errors return { error: string } with HTTP 200
 *  - List endpoints return either {id: object} (dict-of-id) or [] (empty array)
 *  - The `server` param is the internal server_id (numeric), NOT the tenant code
 *  - The `id` param is the internal DB id, NOT the human ext number
 */

import axios, { AxiosInstance } from 'axios'

/* ============================================================================
 * Response types — these mirror what the Bicom API actually returns.
 * The mapper converts these into SONIQ shapes.
 * ============================================================================ */

export interface ApiError { error: string }

export interface BicomTenantSummary {
  id: string           // server_id (also the API key for tenant queries)
  server_id: string
  name?: string
  tenantcode?: string  // human tenant code, e.g. "216" for Value Comms
  package?: string
  ext_length?: string
  country_code?: string
}

export interface BicomExtSummary {
  id: string                     // internal DB id (used for .configuration lookup)
  name?: string
  email?: string
  ext: string                    // the extension number (e.g. "2001")
  protocol?: string              // "sip"
  location?: string              // "remote", "local", etc.
  ua_id?: string
  ua_name?: string
  ua_fullname?: string
  status?: string                // "enabled" | "disabled"
  macaddress?: string
  sn?: string
  linenum?: string
  user_location?: string
  department?: string
}

export interface BicomExtFullConfig {
  id: string
  name?: string
  email?: string
  ext: string
  pin?: string
  service_plan?: string
  protocol?: string
  location?: string
  status?: string
  options: {
    username?: string           // SIP username
    secret?: string             // SIP password (cleartext)
    callerid?: string           // "Phil <2001>"
    voicemail?: string
    voice_tz?: string
    ext_timezone?: string
    mac?: string
    sn?: string
    ua?: string
    ringtime?: string
    autoprovisiong?: string
    setcallerid?: string
    incominglimit?: string
    outgoinglimit?: string
    limit_notify_email?: string
    ringtoneforlocalcalls?: string
    allow?: string[]            // codec list: ["ulaw", "alaw", "h264"]
    videosupport?: string
    recordcalls?: string
    recordsilent?: string
    dhcp?: string
    dtmfmode?: string
    context?: string            // e.g. "t-216" (per-tenant context)
    nat?: string
    canreinvite?: string
    qualify?: string
    host?: string               // "dynamic" for register-based endpoints
    transport?: string          // "tcp" | "udp" | "tls"
    show_in_app?: string
    show_in_monitor?: string
    tfa_expiry_time?: string
    tfa_max_inactivity?: string
    incoming_dialoptions?: string
    vm_greeting_message?: string
    [k: string]: unknown        // Bicom has ~80+ options fields; keep flexible
  }
}

export interface BicomIVRSummary {
  id: string                    // internal DB id
  name: string
  type: '0' | '1' | '2' | '3'   // 0=Standard, 1=Multi-digit, 2=PIN, 3=Meeting
  ext: string                   // dial extension (e.g. "5000")
  greeting: string              // audio filename (no ext)
  keymap: Record<string, {
    destination: 'IVR' | 'Ring Group' | 'Extension' | 'Queue' | 'Voicemail' |
                 'Directory' | 'Remote Access' | 'Fax to E-mail' |
                 'Call External Number' | 'CRM Routing' | string
    value: string
  }>
  status: 'enabled' | 'disabled' | string
  operator?: string | null
}

export interface BicomRingGroupSummary {
  id: string
  name: string
  ext: string
  destinations: string         // comma-separated member exts: "2001,2003"
  last_dest?: string           // overflow ext
  last_dest_vm?: 'yes' | 'no' | string
}

export interface BicomRingGroupFull {
  id: string
  name: string
  ext: string
  destinations: string
  options: {
    timeout?: string
    last_dest?: string
    greeting?: string
    loops?: string
    exit_digit?: string
    exit_ext?: string
    record?: string
    record_silent?: string
    ganswer?: string
    max_limit?: string
    store_cdr?: string
    overwrite_timeout?: string
    call_rating_ext?: string
    looping_mode?: 'per_ext' | 'per_group' | string
    skip_pbd_local?: string
    preserve_callerid?: string
    member_es_disable?: string
    last_dest_vm?: string
    confirm_calls?: string
    timeout_msg?: string
    dial_options?: string
    ring_strategy?: 'all' | 'linear' | 'random' | 'roundrobin' | 'leastrecent' | 'fewestcalls' | string
    custom_ringtone?: string
    callerid?: string          // template like "Sales %CALLERID%"
    confirm_msg?: string
    confirm_answered_msg?: string
    [k: string]: unknown
  }
}

/** Enhanced Ring Group (Bicom's queue).
 *  NB: Bicom's ERG endpoint returns the extension as `number`, not `ext`
 *  (differs from ring_group). We alias both here so callers can use either. */
export interface BicomERGSummary {
  id: string
  name: string
  number: string       // Bicom's real field name for the queue extension
  ext?: string         // alias — populated from `number` at fetch time
  status?: string
  strategy?: string
  [k: string]: unknown
}

export interface BicomERGMember {
  ext: string
  penalty?: string
  paused?: string
  [k: string]: unknown
}

export interface BicomDIDSummary {
  id: string
  number: string                            // "443300436871" — non-E.164 in Bicom form
  number2?: string | null
  server: string
  trunk: string                             // internal trunk id
  type: 'IVR' | 'Extension' | 'Ring Group' | 'Queue' | 'Voicemail' | string
  ext: string                               // the target ext (5001 for an IVR, 2001 for a user, 3000 for a RG)
  e164?: string | null
  e164_2?: string | null
  status: 'enabled' | 'disabled' | string
  name?: string                             // free-form label
  sms_enabled?: string | null
  prioritize_clirouting?: string | null
  e911?: string
}

/**
 * Opening-times response varies per entity type.
 * All share the same shape: closed_dates + open_days (regular hours).
 */
export interface BicomOtimes {
  status?: 'on' | 'off' | string
  greeting?: string                         // out-of-hours greeting filename
  default_dest_ext?: string                 // default fallback destination
  default_dest_is_vm?: 'yes' | 'no' | string
  closed_dates?: BicomOtimesClosedDate[]    // specific date ranges (holidays)
  open_days?: BicomOtimesOpenDay[]          // regular weekly hours
  [k: string]: unknown
}

export interface BicomOtimesClosedDate {
  description?: string
  destination: string                       // target ext during closed time
  date_from: string                         // "2023-12-22"
  date_to: string
  time_from: string                         // "12:00"
  time_to: string                           // "23:55"
}

export interface BicomOtimesOpenDay {
  day: string                               // "1"=Mon .. "7"=Sun (or Bicom-specific numbering)
  time_from: string
  time_to: string
  destination?: string                      // optional per-day custom destination
  [k: string]: unknown
}

export interface BicomTrunkSummary {
  id: string
  name?: string
  type?: string                             // "sip", "pjsip", "iax", etc.
  status?: string
  [k: string]: unknown
}

/* ============================================================================
 * Client class — one method per endpoint we use.
 * All methods normalize dict-of-id responses to arrays for easier iteration.
 * ============================================================================ */

function toEntityArray<T extends { id: string }>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && !('error' in data)) {
    return Object.entries(data as Record<string, Omit<T, 'id'>>).map(
      ([id, e]) => ({ id, ...e } as unknown as T)
    )
  }
  return []
}

function isApiError(x: unknown): x is ApiError {
  return typeof x === 'object' && x !== null && typeof (x as ApiError).error === 'string'
}

export class BicomClientV2 {
  private base: string
  private apiKey: string
  private http: AxiosInstance

  constructor(serverUrl: string, apiKey: string, timeoutMs = 30000) {
    this.base = serverUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.http = axios.create({ baseURL: this.base, timeout: timeoutMs })
  }

  private async request<T>(action: string, params: Record<string, string | number> = {}): Promise<T> {
    const r = await this.http.get<T>('/index.php', {
      params: { apikey: this.apiKey, action, ...params },
    })
    return r.data
  }

  /* --- Tenant discovery --- */

  async listTenants(): Promise<BicomTenantSummary[]> {
    const data = await this.request<Record<string, Omit<BicomTenantSummary, 'id' | 'server_id'>>>('pbxware.tenant.list')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.entries(data).map(([serverId, t]) => ({
        id: serverId,
        server_id: serverId,
        ...t,
      }))
    }
    return []
  }

  async getTenantConfig(serverId: string): Promise<unknown> {
    return this.request('pbxware.tenant.configuration', { server: serverId })
  }

  /* --- Extensions --- */

  async listExtensions(serverId: string): Promise<BicomExtSummary[]> {
    const data = await this.request<unknown>('pbxware.ext.list', { server: serverId })
    return toEntityArray<BicomExtSummary>(data)
  }

  /**
   * Full read of a single extension including SIP credentials, MAC/SN, callerid template,
   * ringtime, autoprovisiong flags, allowed codecs, all TFA settings.
   * @param id  the INTERNAL DB id from listExtensions (NOT the ext number)
   */
  async getExtension(serverId: string, id: string): Promise<BicomExtFullConfig | ApiError> {
    const data = await this.request<Record<string, unknown> | ApiError>(
      'pbxware.ext.configuration',
      { server: serverId, id }
    )
    if (isApiError(data)) return data
    // Response is `{internal_id: {...}}` — unwrap
    const entries = Object.entries(data)
    if (entries.length === 0) return { error: 'empty response' }
    const [foundId, cfg] = entries[0]
    return { id: foundId, ...(cfg as Omit<BicomExtFullConfig, 'id'>) }
  }

  /* --- IVRs --- */

  async listIVRs(serverId: string): Promise<BicomIVRSummary[]> {
    const data = await this.request<unknown>('pbxware.ivr.list', { server: serverId })
    return toEntityArray<BicomIVRSummary>(data)
  }

  /**
   * Full IVR config. Bicom names this endpoint "edit" but it's the standard read endpoint.
   * @param id  internal DB id (from listIVRs)
   */
  async getIVR(serverId: string, id: string): Promise<BicomIVRSummary | ApiError> {
    const data = await this.request<Record<string, unknown> | ApiError>(
      'pbxware.ivr.edit',
      { server: serverId, id }
    )
    if (isApiError(data)) return data
    const entries = Object.entries(data)
    if (entries.length === 0) return { error: 'empty response' }
    const [foundId, cfg] = entries[0]
    return { id: foundId, ...(cfg as Omit<BicomIVRSummary, 'id'>) }
  }

  /* --- Ring Groups --- */

  async listRingGroups(serverId: string): Promise<BicomRingGroupSummary[]> {
    const data = await this.request<unknown>('pbxware.ring_group.list', { server: serverId })
    return toEntityArray<BicomRingGroupSummary>(data)
  }

  async getRingGroup(serverId: string, id: string): Promise<BicomRingGroupFull | ApiError> {
    const data = await this.request<Record<string, unknown> | ApiError>(
      'pbxware.ring_group.configuration',
      { server: serverId, id }
    )
    if (isApiError(data)) return data
    const entries = Object.entries(data)
    if (entries.length === 0) return { error: 'empty response' }
    const [foundId, cfg] = entries[0]
    return { id: foundId, ...(cfg as Omit<BicomRingGroupFull, 'id'>) }
  }

  /* --- Enhanced Ring Groups (Queues) --- */

  async listQueues(serverId: string): Promise<BicomERGSummary[]> {
    const data = await this.request<unknown>('pbxware.erg.list', { server: serverId })
    // Bicom returns queues with `number` (not `ext`) — normalise for downstream.
    return toEntityArray<BicomERGSummary>(data).map(q => ({
      ...q,
      ext: q.ext ?? (q as any).number ?? '',
    }))
  }

  async getQueueMembers(serverId: string, ergId: string): Promise<BicomERGMember[]> {
    const data = await this.request<unknown>('pbxware.erg.members', { server: serverId, id: ergId })
    if (Array.isArray(data)) return data as BicomERGMember[]
    if (data && typeof data === 'object' && !('error' in data)) {
      return Object.values(data as Record<string, BicomERGMember>)
    }
    return []
  }

  /* --- DIDs (DDIs) --- */

  async listDIDs(serverId: string): Promise<BicomDIDSummary[]> {
    const data = await this.request<unknown>('pbxware.did.list', { server: serverId })
    return toEntityArray<BicomDIDSummary>(data)
  }

  /* --- Operation Times (per entity type) --- */

  async getIVROtimes(serverId: string, ivrId: string): Promise<BicomOtimes | null> {
    const data = await this.request<unknown>('pbxware.otimes.ivr.list', { server: serverId, id: ivrId })
    return this.unwrapOtimes(data)
  }

  async getRingGroupOtimes(serverId: string, rgId: string): Promise<BicomOtimes | null> {
    const data = await this.request<unknown>('pbxware.otimes.dial_group.list', { server: serverId, id: rgId })
    return this.unwrapOtimes(data)
  }

  async getQueueOtimes(serverId: string, ergId: string): Promise<BicomOtimes | null> {
    const data = await this.request<unknown>('pbxware.otimes.erg.list', { server: serverId, id: ergId })
    return this.unwrapOtimes(data)
  }

  async getDIDOtimes(serverId: string, didId: string): Promise<BicomOtimes | null> {
    const data = await this.request<unknown>('pbxware.otimes.did.list', { server: serverId, id: didId })
    return this.unwrapOtimes(data)
  }

  async getServerOtimes(serverId: string): Promise<BicomOtimes | null> {
    const data = await this.request<unknown>('pbxware.otimes.servers.list', { server: serverId })
    return this.unwrapOtimes(data)
  }

  private unwrapOtimes(data: unknown): BicomOtimes | null {
    if (!data) return null
    if (Array.isArray(data)) return data.length === 0 ? null : (data[0] as BicomOtimes)
    if (typeof data === 'object' && !('error' in data)) {
      const vals = Object.values(data as Record<string, BicomOtimes>)
      return vals[0] ?? null
    }
    return null
  }

  /* --- Trunks --- */

  async listTrunks(): Promise<BicomTrunkSummary[]> {
    // Server "1" is the master tenant for platform-level trunk queries
    const data = await this.request<unknown>('pbxware.trunk.list', { server: 1 })
    return toEntityArray<BicomTrunkSummary>(data)
  }

  async listTenantTrunks(tenantServerId: string): Promise<BicomTrunkSummary[]> {
    const data = await this.request<unknown>('pbxware.tenant.trunks.list', {
      server: 1, tenant: tenantServerId,
    })
    return toEntityArray<BicomTrunkSummary>(data)
  }

  /* --- Enhanced Services we still care about --- */

  async getExtCallerID(serverId: string, ext: string): Promise<unknown> {
    return this.request('pbxware.ext.es.callerid.get', { server: serverId, ext })
  }

  /**
   * Full outbound-CLI configuration for a user, from ES > Caller ID.
   * Returns:
   *  - callerid                  per-user primary CLI (empty = fall through to default_callerid)
   *  - default_callerid          tenant default
   *  - emergency_callerid        999/112 CLI
   *  - callerid:{trunk}          per-trunk override
   *  - callerid:{trunk}:privacy  presentation flag (blank = allowed)
   *  - allowed_callerids         dict of feature-code-selectable CLI aliases
   *
   * @param id  internal DB id (NOT the ext number)
   */
  async getExtCallerIDConfig(serverId: string, id: string): Promise<BicomCallerIDConfig | ApiError> {
    const data = await this.request<BicomCallerIDConfig | ApiError>(
      'pbxware.ext.es.callerid.configuration',
      { server: serverId, id }
    )
    return data
  }

  async getExtBLFList(serverId: string, ext: string): Promise<unknown> {
    return this.request('pbxware.ext.es.blflist.get', { server: serverId, ext })
  }
}

/* ============================================================================
 * ES > Caller ID configuration response shape.
 *
 * Real sample from VC 216 (Phil, ext 2001):
 *   {
 *     "callerid": "",                        // per-user override empty -> fall through
 *     "emergency_callerid": "",
 *     "default_callerid": "02392003515",     // tenant default fallback
 *     "default_privacy": "",
 *     "callerid:Gamma": "02392003515",       // per-trunk override
 *     "callerid:SONIQ": "02392003515",
 *     "callerid:twilio": "",
 *     "callerid:elavan": "",
 *     "allowed_callerids": {                 // feature-code selectable CLI menu
 *       "1": {"callerid": "02032815871", "label": "Sales 1", "short_code": "0"},
 *       "2": {"callerid": "02032815905", "label": "Sales 2", "short_code": "1"},
 *       ...
 *     }
 *   }
 * When no allowed_callerids are configured, Bicom returns an empty array [] instead of {}.
 * ============================================================================ */

export interface BicomAllowedCallerID {
  callerid: string
  label: string
  short_code?: string
}

export interface BicomCallerIDConfig {
  callerid?: string                       // per-user primary CLI
  emergency_callerid?: string             // 999/112 CLI
  default_callerid?: string               // tenant fallback
  default_privacy?: string
  allowed_callerids?: Record<string, BicomAllowedCallerID> | []
  [k: string]: unknown                    // per-trunk keys: 'callerid:Gamma', 'callerid:Gamma:privacy', ...
}
