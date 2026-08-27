import { sha256Text } from './datasetSnapshots'
import {
  STRATEGY_AFFINITY_CHALLENGER_VERSION,
  STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
} from './multiStrategyPleRouter'
import {
  SELECTION_REFERENCE_CONTRACT_VERSION,
  type SelectionReferenceRowV1,
} from './selectionReferenceEvidence'

export const STRATEGY_ROUTE_RECOVERY_PACKET_SCHEMA = 'strategy-route-recovery-packet-v1'

export type StrategyRouteRecoveryScore = {
  signal_date: string
  symbol: string
  producer_run_id: string
  strategy_registry_checksum: string
  reference_contract_version: string
  incumbent_route_version: string
  incumbent_route_score: number
  challenger_affinity_version: string
  challenger_route_version: string
  challenger_route_score: number
  score_components: string
}

export type StrategyRouteRecoveryPacket = {
  schema_version: typeof STRATEGY_ROUTE_RECOVERY_PACKET_SCHEMA
  route_version: typeof STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION
  affinity_version: typeof STRATEGY_AFFINITY_CHALLENGER_VERSION
  strategy_registry_checksum: string
  reference_contract_version: typeof SELECTION_REFERENCE_CONTRACT_VERSION
  candidate_count: number
  route_score_count: number
  input_packet_checksum: string
  route_score_parity_checksum: string
  route_scores: StrategyRouteRecoveryScore[]
}

function checksumPayloads(scores: StrategyRouteRecoveryScore[]): {
  inputPacket: Array<Record<string, unknown>>
  routeParity: Array<Record<string, unknown>>
} {
  return {
    inputPacket: scores.map((row) => ({
      signal_date: row.signal_date,
      symbol: row.symbol,
      producer_run_id: row.producer_run_id,
      strategy_registry_checksum: row.strategy_registry_checksum,
      reference_contract_version: row.reference_contract_version,
      score_components: row.score_components,
    })),
    routeParity: scores.map(({ score_components: _scoreComponents, ...row }) => row),
  }
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function buildStrategyRouteRecoveryPacket(
  references: SelectionReferenceRowV1[],
): Promise<StrategyRouteRecoveryPacket> {
  if (!references.length) throw new Error('strategy_route_recovery_references_empty')
  const sorted = [...references].sort((left, right) =>
    left.signal_date.localeCompare(right.signal_date)
    || left.symbol.localeCompare(right.symbol)
    || left.producer_run_id.localeCompare(right.producer_run_id))
  const identities = new Set<string>()
  const registryChecksums = new Set<string>()
  const scores: StrategyRouteRecoveryScore[] = []
  for (const row of sorted) {
    const identity = `${row.signal_date}|${row.symbol}|${row.producer_run_id}`
    if (identities.has(identity)) throw new Error(`strategy_route_recovery_duplicate:${identity}`)
    identities.add(identity)
    registryChecksums.add(String(row.strategy_registry_checksum ?? '').trim())
    const incumbent = finite(row.strategy_router_score)
    const challenger = finite(row.strategy_challenger_route_score)
    if (
      row.strategy_router_version == null
      || incumbent == null
      || row.strategy_challenger_affinity_version !== STRATEGY_AFFINITY_CHALLENGER_VERSION
      || row.strategy_challenger_route_version !== STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION
      || challenger == null
      || !row.score_components
    ) throw new Error(`strategy_route_recovery_incomplete:${identity}`)
    scores.push({
      signal_date: row.signal_date,
      symbol: row.symbol,
      producer_run_id: row.producer_run_id,
      strategy_registry_checksum: row.strategy_registry_checksum,
      reference_contract_version: SELECTION_REFERENCE_CONTRACT_VERSION,
      incumbent_route_version: row.strategy_router_version,
      incumbent_route_score: incumbent,
      challenger_affinity_version: row.strategy_challenger_affinity_version,
      challenger_route_version: row.strategy_challenger_route_version,
      challenger_route_score: challenger,
      score_components: row.score_components,
    })
  }
  if (registryChecksums.size !== 1 || ![...registryChecksums][0]) {
    throw new Error('strategy_route_recovery_registry_checksum_mixed_or_missing')
  }
  const { inputPacket, routeParity } = checksumPayloads(scores)
  return {
    schema_version: STRATEGY_ROUTE_RECOVERY_PACKET_SCHEMA,
    route_version: STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
    affinity_version: STRATEGY_AFFINITY_CHALLENGER_VERSION,
    strategy_registry_checksum: [...registryChecksums][0],
    reference_contract_version: SELECTION_REFERENCE_CONTRACT_VERSION,
    candidate_count: sorted.length,
    route_score_count: scores.length,
    input_packet_checksum: await sha256Text(JSON.stringify(inputPacket)),
    route_score_parity_checksum: await sha256Text(JSON.stringify(routeParity)),
    route_scores: scores,
  }
}


export async function verifyStrategyRouteRecoveryPacket(value: unknown): Promise<boolean> {
  const packet = value as StrategyRouteRecoveryPacket | null
  if (
    !packet
    || packet.schema_version !== STRATEGY_ROUTE_RECOVERY_PACKET_SCHEMA
    || packet.route_version !== STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION
    || packet.affinity_version !== STRATEGY_AFFINITY_CHALLENGER_VERSION
    || packet.reference_contract_version !== SELECTION_REFERENCE_CONTRACT_VERSION
    || !/^sha256:[a-f0-9]{64}$/i.test(packet.strategy_registry_checksum)
    || !Array.isArray(packet.route_scores)
    || packet.candidate_count <= 0
    || packet.candidate_count !== packet.route_score_count
    || packet.route_score_count !== packet.route_scores.length
  ) return false
  const identities = new Set<string>()
  for (const row of packet.route_scores) {
    const identity = `${row.signal_date}|${row.symbol}|${row.producer_run_id}`
    if (identities.has(identity)) return false
    identities.add(identity)
    if (
      !row.signal_date
      || !row.symbol
      || !row.producer_run_id
      || row.strategy_registry_checksum !== packet.strategy_registry_checksum
      || row.reference_contract_version !== SELECTION_REFERENCE_CONTRACT_VERSION
      || !row.incumbent_route_version
      || finite(row.incumbent_route_score) == null
      || row.challenger_affinity_version !== STRATEGY_AFFINITY_CHALLENGER_VERSION
      || row.challenger_route_version !== STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION
      || finite(row.challenger_route_score) == null
      || !row.score_components
    ) return false
  }
  const { inputPacket, routeParity } = checksumPayloads(packet.route_scores)
  return packet.input_packet_checksum === await sha256Text(JSON.stringify(inputPacket))
    && packet.route_score_parity_checksum === await sha256Text(JSON.stringify(routeParity))
}

export function applyStrategyRouteRecoveryScores(
  references: SelectionReferenceRowV1[],
  scores: StrategyRouteRecoveryScore[],
  signalDate: string,
  producerRunId: string,
): SelectionReferenceRowV1[] {
  if (scores.length !== references.length) {
    throw new Error('route_recovery_coverage_mismatch:' + scores.length + '/' + references.length)
  }
  const bySymbol = new Map<string, StrategyRouteRecoveryScore>()
  for (const score of scores) {
    const symbol = String(score.symbol ?? '').trim()
    if (!symbol || bySymbol.has(symbol)) throw new Error('route_recovery_duplicate_symbol:' + symbol)
    bySymbol.set(symbol, score)
  }
  return references.map((row) => {
    const symbol = String(row.symbol ?? '').trim()
    const recovery = bySymbol.get(symbol)
    if (!recovery) throw new Error('route_recovery_symbol_missing:' + signalDate + ':' + symbol)
    if (
      recovery.signal_date !== signalDate
      || recovery.producer_run_id !== producerRunId
      || recovery.strategy_registry_checksum !== String(row.strategy_registry_checksum ?? '').trim()
      || recovery.reference_contract_version !== SELECTION_REFERENCE_CONTRACT_VERSION
    ) throw new Error('route_recovery_identity_mismatch:' + signalDate + ':' + symbol)
    const incumbentScore = finite(row.strategy_router_score)
    const challengerScore = finite(row.strategy_challenger_route_score)
    if (
      (incumbentScore != null && Math.abs(incumbentScore - recovery.incumbent_route_score) > 1e-9)
      || (challengerScore != null && Math.abs(challengerScore - recovery.challenger_route_score) > 1e-9)
      || (row.strategy_router_version && row.strategy_router_version !== recovery.incumbent_route_version)
      || (row.strategy_challenger_affinity_version && row.strategy_challenger_affinity_version !== recovery.challenger_affinity_version)
      || (row.strategy_challenger_route_version && row.strategy_challenger_route_version !== recovery.challenger_route_version)
    ) throw new Error('route_recovery_carrier_conflict:' + signalDate + ':' + symbol)
    return {
      ...row,
      strategy_router_version: recovery.incumbent_route_version,
      strategy_router_score: recovery.incumbent_route_score,
      strategy_challenger_affinity_version: recovery.challenger_affinity_version,
      strategy_challenger_route_version: recovery.challenger_route_version,
      strategy_challenger_route_score: recovery.challenger_route_score,
    }
  })
}
