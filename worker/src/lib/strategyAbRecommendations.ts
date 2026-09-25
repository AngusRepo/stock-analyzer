import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'
import { readPairedNavSnapshotRaw } from './pairedNavSnapshotRead'
import { strategyAbTag } from './strategyAbContract'
import { sha256Text } from './datasetSnapshots'

import type { StrategyPick, StrategyAllocationView, StrategyAbRecommendations } from './strategyAbRecommendationContract'
const unavailable = (reason: string): StrategyAllocationView => ({ status: 'unavailable', picks: [], cash_weight: null, source_id: null, reason })

export function allocationView(rows: unknown, source: string): StrategyAllocationView {
  if (!Array.isArray(rows)) throw Error('strategy_ab_allocation_missing')
  const seen = new Set<string>()
  const picks: StrategyPick[] = []
  for (const row of rows) {
    if (typeof row?.symbol !== 'string' || !row.symbol || seen.has(row.symbol)
      || typeof row.allocation_weight !== 'number' || !Number.isFinite(row.allocation_weight)
      || row.allocation_weight < 0 || row.allocation_weight > 1) throw Error('strategy_ab_allocation_invalid')
    seen.add(row.symbol)
    if (row.allocation_weight > 1e-7) picks.push({ symbol: row.symbol, weight: row.allocation_weight })
  }
  const total = picks.reduce((sum, row) => sum + row.weight, 0)
  if (total > 1 + 1e-8) throw Error('strategy_ab_weight_sum_invalid')
  return { status: 'available', picks: picks.sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol)),
    cash_weight: Math.max(0, 1 - total), source_id: source }
}

export function validateResearchRecommendations(body: StrategyAbRecommendations): StrategyAbRecommendations {
  if (body?.schema_version !== 'strategy-ab-recommendations-v1' || body.scope !== 'retrospective_research'
    || body.production_effect !== false || body.nav_maturity_credit !== 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !Number.isFinite(Date.parse(body.generated_at))
    || !body.source_checksums || !['allocation_context', 'A_model', 'B_model'].every(key => body.source_checksums?.[key])
    || Object.values(body.source_checksums).some(value => !/^[a-f0-9]{64}$/.test(value))) throw Error('strategy_ab_research_identity_invalid')
  for (const role of ['A', 'B'] as const) {
    const arm = body[role]
    if (arm?.status !== 'available' || !arm.source_id || !Array.isArray(arm.picks)) throw Error('strategy_ab_research_arm_missing')
    const checked = allocationView(arm.picks.map(row => ({ symbol: row.symbol, allocation_weight: row.weight })), arm.source_id)
    if (typeof arm.cash_weight !== 'number' || !Number.isFinite(arm.cash_weight) || Math.abs(checked.cash_weight! - arm.cash_weight) > 1e-8) throw Error('strategy_ab_research_cash_mismatch')
  }
  return body
}

/** Retire display candidates only after the immutable activation is verified. */
async function retiredComparisonPairs(db: D1Database, date: string): Promise<Set<string>> {
  const response = await db.prepare(`SELECT s.*, o.payload_checksum AS old_checksum,
    n.payload_checksum AS new_checksum, o.source_run_id AS old_source, n.source_run_id AS new_source,
    o.snapshot_kind AS old_kind, n.snapshot_kind AS new_kind,
    n.signal_date AS new_signal_date, n.frozen_at AS new_frozen_at
    FROM paired_native_prestart_successions_v1 s
    JOIN paired_nav_frozen_manifests_v1 o ON o.snapshot_id=s.old_snapshot_id
    LEFT JOIN paired_nav_frozen_manifests_v1 n ON n.snapshot_id=s.new_snapshot_id
    WHERE o.signal_date=? LIMIT 65`).bind(date).all<Record<string, any>>()
  if (response.success === false || !Array.isArray(response.results) || response.results.length > 64)
    throw Error('strategy_ab_succession_query_invalid')
  const retired = new Set<string>()
  for (const row of response.results) {
    const body = JSON.parse(row.payload_json)
    if (await sha256Text(row.payload_json) !== `sha256:${row.payload_checksum}`
      || body.schema_version !== 'paired-native-prestart-successor-v1'
      || body.inherited_mature_sessions !== 0 || body.production_effect !== false
      || ['old_snapshot_id', 'new_snapshot_id', 'old_pair_id', 'new_pair_id'].some(key => body[key] !== row[key])
      || row.old_kind !== 'execution_pair' || row.new_kind !== 'execution_pair'
      || row.old_source !== row.old_pair_id || row.new_source !== row.new_pair_id
      || row.new_signal_date !== date || body.old_payload_checksum !== row.old_checksum
      || body.new_payload_checksum !== row.new_checksum
      || !(Date.parse(row.new_frozen_at) <= Date.parse(row.recorded_at)
        && Date.parse(row.recorded_at) < Date.parse(body.first_phase_at)))
      throw Error('strategy_ab_succession_identity_invalid')
    retired.add(row.old_pair_id)
  }
  return retired
}

export async function readStrategyAbRecommendations(env: Bindings, date: string): Promise<StrategyAbRecommendations> {
  const result: StrategyAbRecommendations = { schema_version: 'strategy-ab-recommendations-v1', date,
    scope: 'daily_allocation', generated_at: new Date().toISOString(), production_effect: false, nav_maturity_credit: 0,
    A: unavailable('當日 A 配置尚未產生'), B: unavailable('當日 B 配置尚未產生；不代表 B 選擇持有現金') }
  const paper = paperDomainDatabase(env), learning = databaseForDataDomain(env, 'learning')
  // parent_plan_id is the prior active plan, including valid cross-day plans.
  // It is lineage, not a marker that today's allocation is provisional.
  const plan = await paper.prepare("SELECT plan_id,payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 AND signal_date=? ORDER BY rowid DESC LIMIT 1")
    .bind(date).first<{ plan_id: string; payload_json: string }>()
  if (plan) {
    const body = JSON.parse(plan.payload_json)
    if (body.signal_date !== date || body.plan_id !== plan.plan_id) throw Error('strategy_ab_primary_date_mismatch')
    if (!body.weights || typeof body.weights !== 'object' || Array.isArray(body.weights)) throw Error('strategy_ab_primary_weights_missing')
    result.A = allocationView(Object.entries(body.weights).map(([symbol, weight]) => ({ symbol, allocation_weight: weight })), plan.plan_id)
  }
  const manifests = await learning.prepare("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE signal_date=? AND snapshot_kind='allocation_pair' ORDER BY frozen_at DESC LIMIT 65")
    .bind(date).all<Record<string, any>>()
  if ((manifests.results?.length ?? 0) > 64) throw Error('strategy_ab_comparison_inventory_exceeds_bound')
  const retired = await retiredComparisonPairs(learning, date)
  const matches: Array<{ manifest: Record<string, any>; content: any }> = []
  for (const manifest of manifests.results ?? []) {
    if (retired.has(manifest.source_run_id)) continue
    const body = JSON.parse(await readPairedNavSnapshotRaw(learning, manifest, true))
    if (body.signal_date !== date || body.snapshot_kind !== 'allocation_pair') throw Error('strategy_ab_snapshot_date_mismatch')
    const tag = strategyAbTag(body.content?.configuration?.strategy_bundle?.strategy_ab)
    if (tag?.role === 'B' && tag.baseline_primary?.role === 'A') matches.push({ manifest, content: body.content })
  }
  if (matches.length === 1) {
    const { manifest, content } = matches[0]
    const arms = content.allocation_preview ?? { A: content.baseline?.output, B: content.candidate?.output }
    if (arms.A && arms.B) {
      result.A = allocationView(arms.A, manifest.snapshot_id)
      result.B = allocationView(arms.B, manifest.snapshot_id)
      result.generated_at = manifest.frozen_at
      if (!manifest.prospective) result.scope = 'retrospective_research'
      return result
    }
    result.B = unavailable('B 配置已封存，但舊版索引尚未提供選股與權重')
  } else if (matches.length > 1) result.B = unavailable('當日有多組 B 比較，尚未確認同一版本')
  // A late research result is explicit observation only; never a Paper/NAV input.
  if (matches.length === 0) {
    const ref = await env.KV.get(`strategy-ab:recommendations:${date}`, 'json') as { r2_key: string; checksum: string } | null
    if (ref) {
      if (!ref.r2_key.startsWith('evidence/class=ten_year_cold_archive/domain=strategy-ab-recommendations/')) throw Error('strategy_ab_research_path_invalid')
      const object = await env.ARTIFACTS.get(ref.r2_key)
      if (!object) throw Error('strategy_ab_research_object_missing')
      const raw = await object.text()
      if (await sha256Text(raw) !== ref.checksum) throw Error('strategy_ab_research_checksum_mismatch')
      const packet = validateResearchRecommendations(JSON.parse(raw).payload)
      if (packet.date !== date) throw Error('strategy_ab_research_date_mismatch')
      return packet
    }
  }
  return result
}
