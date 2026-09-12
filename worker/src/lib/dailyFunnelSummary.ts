/** Full-population counters must never be inferred from capped drilldown rows. */
type Row = Record<string, any>
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const object = (value: unknown): Row => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}
const metric = (label: string, value: number | null) => ({ label, value })

export function buildFinalSignalLayer(signals: Row | null, expectedCount?: number | null) {
  const total = count(signals?.recommendation_count)
  const buy = count(signals?.buy_signal_count)
  const hold = count(signals?.hold_count)
  const sell = count(signals?.sell_count)
  const other = count(signals?.other_count)
  const complete = total != null && buy != null && hold != null && sell != null && other != null
    && buy + hold + sell + other === total && (expectedCount === undefined || (expectedCount != null && total === expectedCount))
  return {
    layer: '交易訊號', label: '當日最新交易訊號', stage: 'daily_recommendations.signal', mode: 'signals',
    signal_scope: 'daily_snapshot_for_run_symbols',
    input_count: complete ? total : null, passed: complete ? buy : null, eliminated: null,
    availability: complete ? 'available' : 'unavailable',
    reason_code: complete ? null : 'final_signal_coverage_incomplete',
    metrics: [metric('BUY', complete ? buy : null), metric('HOLD', complete ? hold : null),
      metric('SELL', complete ? sell : null), metric('其他／未決', complete ? other : null)],
    note: complete ? '本批次名單的當日最新訊號；HOLD 不等於淘汰，也不是 L4 alpha EV 的晉級結果。' : '本批次訊號尚未完整，暫不顯示精確數量。',
  }
}

export function buildDailyFunnelLayers(run: Row, stages: Row[], signals: Row | null) {
  const metadata = object(run.metadata)
  const receipt = object(metadata.l0DropReasonConservation)
  const conservation = object(receipt.conservation)
  const total = count(receipt.source_universe), pass = count(receipt.pass), drop = count(receipt.drop)
  const reasons = Object.values(object(receipt.primary_reason_counts)).map(count)
  const l0Ready = run.status === 'success' && receipt.schema_version === 'l0-drop-reason-conservation-v1'
    && receipt.source_stage === 'universe' && total != null && pass != null && drop != null
    && total === pass + drop && pass === count(run.universe_count)
    && reasons.every(n => n != null) && reasons.reduce<number>((sum, n) => sum + (n ?? 0), 0) === drop
    && conservation.source_universe_equals_pass_plus_drop === true
    && conservation.primary_reason_counts_equal_drop === true
    && conservation.every_drop_has_exactly_one_primary_reason === true
  const stage = (name: string) => stages.find(row => row.stage === name)
  const universe = stage('universe')
  const telemetry = object(object(metadata.strategyCandidatePool).layer1_telemetry)
  const seed = stage('l1_candidate_seed_after_overlay')
  const selected = count(telemetry.l15_router_ml_slate_count), observed = count(telemetry.l15_router_observe_only_count)
  const l1Ready = l0Ready && selected != null && observed != null
    && count(telemetry.source_universe_count) === pass && selected + observed === pass
    && count(seed?.selected_count) === selected && count(seed?.total_count) === selected
  const queue = stage('l15_ml_slate_queue')
  const queued = count(queue?.total_count)
  const l2Ready = l1Ready && queued === selected && count(queue?.drop_count) === 0
  const ml = stage('layer3_formal_ml_gate')
  const evaluated = count(ml?.total_count), qualified = count(ml?.pass_count)
  const l3Ready = l2Ready && evaluated === queued && evaluated != null && qualified != null && qualified <= evaluated
  return [
    { layer: 'L0', label: '股票母體與硬性篩選', stage: 'universe', mode: 'gate',
      input_count: l0Ready ? total : null, passed: l0Ready ? pass : null, eliminated: l0Ready ? drop : null,
      availability: l0Ready ? 'available' : 'unavailable', reason_code: l0Ready ? null : 'l0_conservation_receipt_missing_or_invalid',
      detail_coverage: { recorded: count(universe?.total_count), expected: l0Ready ? total : null },
      metrics: [metric('通過', l0Ready ? pass : null), metric('淘汰', l0Ready ? drop : null)],
      note: l0Ready ? `母體 ${total} 檔；使用完整批次統計，明細可能截斷。` : '缺少有效的完整批次統計，不能用部分明細推算。' },
    { layer: 'L1', label: '策略候選', stage: 'l1_candidate_seed_after_overlay', mode: 'selection',
      input_count: l1Ready ? pass : null, passed: l1Ready ? selected : null, eliminated: null,
      availability: l1Ready ? 'available' : 'unavailable', reason_code: l1Ready ? null : 'candidate_conservation_incomplete',
      metrics: [metric('入選 ML 名單', l1Ready ? selected : null), metric('僅觀察', l1Ready ? observed : null)],
      note: '僅觀察仍保留策略證據，不等於硬性淘汰。' },
    { layer: 'L2', label: 'ML 評估佇列', stage: 'l15_ml_slate_queue', mode: 'queue',
      input_count: l2Ready ? selected : null, passed: l2Ready ? queued : null, eliminated: null,
      availability: l2Ready ? 'available' : 'unavailable', reason_code: l2Ready ? null : 'ml_queue_coverage_incomplete',
      metrics: [metric('已入列', l2Ready ? queued : null), metric('未入列', l2Ready ? 0 : null)], note: null },
    { layer: 'L3', label: '正式 ML 證據', stage: 'layer3_formal_ml_gate', mode: 'evidence_only',
      input_count: l3Ready ? queued : null, evaluated: l3Ready ? evaluated : null, passed: l3Ready ? qualified : null, eliminated: null,
      availability: l3Ready ? 'available' : 'unavailable', reason_code: l3Ready ? null : 'ml_evidence_coverage_incomplete',
      metrics: [metric('完成評估', l3Ready ? evaluated : null), metric('證據合格', l3Ready ? qualified : null),
        metric('證據未合格', l3Ready ? evaluated! - qualified! : null)], note: '證據合格表示模型輸出可用，不代表買進訊號。' },
    buildFinalSignalLayer(signals, l2Ready ? queued : null),
  ]
}
