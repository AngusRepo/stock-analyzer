import contractJson from '../../../data/finlab_source_contract.json'

type FinLabLaneContract = {
  canonical_datasets?: string[]
  required_fields?: string[]
  optional_fields?: string[]
  sentinel_field?: string
  fields?: Record<string, { required?: boolean }>
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
