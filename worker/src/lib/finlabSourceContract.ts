import contractJson from '../../../data/finlab_source_contract.json'

type FinLabLaneContract = {
  canonical_datasets?: string[]
  required_fields?: string[]
  optional_fields?: string[]
  sentinel_field?: string
  fields?: Record<string, { required?: boolean }>
  late_publication?: { fields?: string[]; retry_cutoff_tw?: string }
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

// A capture that failed only because a late-published field is not out yet for the target date.
export function classifyFinLabLateLaneNotReady(summary: string | null | undefined): boolean {
  const text = String(summary ?? '')
  if (/\bfinlab_source_not_ready\b/.test(text)) return true
  const fields = new Set(finLabLatePublicationFields())
  const missing = [...text.matchAll(/daily_composition_market_dates_missing:([A-Za-z0-9_,]+)/g)]
    .flatMap((match) => match[1].split(',').filter(Boolean))
  return missing.length > 0 && missing.every((field) => fields.has(field))
}
