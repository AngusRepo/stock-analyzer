import contractJson from '../../../data/finlab_source_contract.json'

type FinLabLaneContract = {
  canonical_datasets?: string[]
  required_fields?: string[]
  optional_fields?: string[]
  sentinel_field?: string
  fields?: Record<string, { required?: boolean }>
  late_publication?: { fields?: string[]; retry_cutoff_tw?: string }
  d1_category_scope?: Record<string, string[]>
}

type FinLabSourceContract = {
  schema_version: string
  feature_flags?: Record<string, boolean>
  statuses?: string[]
  lanes?: Record<string, FinLabLaneContract>
}

export const FINLAB_SOURCE_CONTRACT = contractJson as FinLabSourceContract

export function finLabContractFlagDefault(name: string): boolean {
  return Boolean(FINLAB_SOURCE_CONTRACT.feature_flags?.[name])
}

export function finLabCanonicalDatasetsForLane(lane: string): string[] {
  return FINLAB_SOURCE_CONTRACT.lanes?.[lane]?.canonical_datasets ?? []
}

/** Category substrings D1 keeps per regime-context dataset; the materializer writes only these, the GCS raw keeps all. */
export function finLabRegimeContextD1CategoryScope(): Record<string, string[]> {
  return FINLAB_SOURCE_CONTRACT.lanes?.regime_context?.d1_category_scope ?? {}
}

/** WHERE predicate (with binds) for the canonical_regime_context_daily rows that d1_category_scope keeps. */
export function finLabRegimeContextScopePredicate(): { sql: string; binds: string[] } {
  const scope = Object.entries(finLabRegimeContextD1CategoryScope())
  if (!scope.length) return { sql: '1 = 1', binds: [] }
  const binds = scope.map(([dataset]) => dataset)
  const scoped = scope.map(([dataset, parts]) => {
    binds.push(dataset, ...parts.map((part) => `%${part}%`))
    return `(dataset = ? AND (${parts.map(() => 'category LIKE ?').join(' OR ')}))`
  })
  return { sql: `(dataset NOT IN (${scope.map(() => '?').join(', ')}) OR ${scoped.join(' OR ')})`, binds }
}

export function finLabRequiredFieldsForLane(lane: string): string[] {
  return FINLAB_SOURCE_CONTRACT.lanes?.[lane]?.required_fields ?? []
}

export function finLabSentinelFieldForLane(lane: string): string | undefined {
  return FINLAB_SOURCE_CONTRACT.lanes?.[lane]?.sentinel_field
}

export function finLabAllContractLanes(): string[] {
  return Object.keys(FINLAB_SOURCE_CONTRACT.lanes ?? {})
}

// Fields whose same-day value FinLab often publishes after the evening-chain root's first capture.
export function finLabLatePublicationFields(): string[] {
  return Object.values(FINLAB_SOURCE_CONTRACT.lanes ?? {}).flatMap((lane) => lane.late_publication?.fields ?? [])
}

export function finLabLatePublicationFieldsForLane(lane: string): string[] {
  return FINLAB_SOURCE_CONTRACT.lanes?.[lane]?.late_publication?.fields ?? []
}

export function finLabLateRetryCutoffTw(): string {
  const cutoffs = [...new Set(Object.values(FINLAB_SOURCE_CONTRACT.lanes ?? {})
    .map((lane) => lane.late_publication?.retry_cutoff_tw)
    .filter((value): value is string => value != null))]
  if (cutoffs.length !== 1 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffs[0]))
    throw new Error(`finlab_late_publication_cutoff_invalid:${cutoffs.join(',') || 'missing'}`)
  return cutoffs[0]
}

// No new late-lane attempt is sent at or after the cutoff on the run date (TW).
export function finLabLateRetryCutoffPassed(runDate: string, nowMs: number = Date.now()): boolean {
  const cutoffMs = Date.parse(`${runDate}T${finLabLateRetryCutoffTw()}:00+08:00`)
  if (!Number.isFinite(cutoffMs)) throw new Error(`finlab_late_publication_run_date_invalid:${runDate}`)
  return nowMs >= cutoffMs
}

// The Modal job reports an uncaught exception as `<type>: <message>`. A network or storage-transport failure says
// nothing about the data, so a fresh capture may succeed; a quota refusal will not.
const FINLAB_TRANSIENT_EXCEPTION = new RegExp('^\\s*(?:ConnectionError|ConnectionResetError|ConnectionAbortedError|ConnectionRefusedError|'
  + 'BrokenPipeError|ConnectTimeout|ReadTimeout|ChunkedEncodingError|ProtocolError|SSLError|IncompleteRead|TimeoutError|'
  + 'RemoteDisconnected|URLError|TransportError|RetryError|InternalServerError|BadGateway|ServiceUnavailable|'
  + 'GatewayTimeout|DeadlineExceeded):')
// Same quota markers as tools/finlab_v4_remote_backfill.py is_finlab_quota_error.
const FINLAB_QUOTA = /Usage exceed|quota|VIP program|5000\s*MB\/day/i

/** A FinLab capture that died on a transient transport failure (11/16: GCS upload `write operation timed out`). */
export function classifyFinLabTransientFailure(summary: string | null | undefined): boolean {
  const text = String(summary ?? '')
  return FINLAB_TRANSIENT_EXCEPTION.test(text) && !FINLAB_QUOTA.test(text)
}

// A capture that failed only because a late-published field is not out yet for the target date.
export function classifyFinLabLateLaneNotReady(summary: string | null | undefined): boolean {
  const text = String(summary ?? '')
  if (/\bfinlab_source_not_ready\b/.test(text)) return true
  const fields = new Set(finLabLatePublicationFields())
  const missing = [...text.matchAll(/daily_composition_market_dates_missing:([A-Za-z0-9_,]+)/g)]
    .flatMap((match) => match[1].split(',').filter(Boolean))
  return missing.length > 0 && missing.every((field) => fields.has(field))
}
