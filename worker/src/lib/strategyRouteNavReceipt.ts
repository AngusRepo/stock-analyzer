/** Persisted publication receipt, not a fresh efficacy decision on each read. */
import { L15_MARGINAL_SLATE_BUILDER_VERSION, STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION } from './multiStrategyPleRouter'
import { NAV_GATE_SCHEMA } from './pairedNavPromotionEvidence'
export const ROUTE_NAV_ARTIFACT_VERSION = 'strategy-route-nav-adoption-v1'
export const routeReceiptHash = async (raw: string): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('')

export async function readRouteNavReceipt(row: Record<string, any>): Promise<Record<string, any>> {
  const fail = (): never => { throw new Error('strategy_route_nav_receipt_invalid') }
  let receipt: Record<string, any>
  try { receipt = JSON.parse(row.gate_json) } catch { return fail() }
  const nav = receipt?.gate?.nav_validation
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
  if (row.artifact_version !== ROUTE_NAV_ARTIFACT_VERSION || row.route_floor !== null
    || row.status !== 'promoted' || receipt?.schema_version !== ROUTE_NAV_ARTIFACT_VERSION
    || receipt.run_id !== row.run_id || receipt.policy_definition?.challenger_version !== row.candidate_route_version
    || !/^[a-f0-9]{64}$/.test(receipt.artifact_checksum) || receipt.gate?.decision !== 'PASS'
    || receipt.gate.schema_version !== NAV_GATE_SCHEMA || receipt.gate.training_dispatched !== false
    || receipt.gate.evaluation_unit !== 'original_costed_paired_daily_nav'
    || !Array.isArray(receipt.gate.failed_gates) || receipt.gate.failed_gates.length !== 0
    || receipt.gate.candidate_artifact_id !== receipt.artifact_id
    || receipt.gate.candidate_artifact_checksum !== receipt.artifact_checksum
    || nav?.decision !== 'PASS' || nav?.owner !== 'l15_route'
    || nav.candidate_artifact_id !== receipt.artifact_id || nav.candidate_checksum !== receipt.artifact_checksum
    || receipt.gate.evaluation_evidence_checksum !== nav.decision_checksum
    || typeof nav.decision_payload_json !== 'string'
    || await routeReceiptHash(nav.decision_payload_json) !== nav.decision_checksum) return fail()
  if (receipt.policy_definition.challenger_version !== STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION
    || receipt.policy_definition.slate_builder_version !== L15_MARGINAL_SLATE_BUILDER_VERSION)
    throw new Error('strategy_route_nav_runtime_version_unavailable')
  const { decision_checksum, decision_payload_json, ...fields } = nav
  let body: any
  try { body = JSON.parse(decision_payload_json) } catch { return fail() }
  if (JSON.stringify(canonical(body)) !== JSON.stringify(canonical(fields))
    || receipt.artifact_checksum !== await routeReceiptHash(JSON.stringify(['paired-nav-route-policy-v1',
      receipt.policy_definition.challenger_version, receipt.policy_definition.slate_builder_version]))
    || receipt.artifact_id !== `l15_route:${receipt.policy_definition.challenger_version}:${receipt.artifact_checksum}`
    || row.run_id !== `route-nav:${receipt.artifact_checksum}:${decision_checksum}`) return fail()
  return receipt
}
