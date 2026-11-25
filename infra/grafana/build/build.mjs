#!/usr/bin/env node
/** Builds the StockVision dashboards.
 *   node build.mjs --mode live     → ../dashboards/*.json            (queries the monitoring Worker)
 *   node build.mjs --mode fixture  → ../dashboards/fixture/*.json    (the same panels over fixtures/*.json)
 *   node build.mjs --check         → fails unless both modes differ only in where a query reads from
 * Fixtures and dag.json come from dump-fixtures.mts and export-dag.mts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chainCanvas, CHAIN_PIVOT, laneCanvas, laneSlots } from './canvas.mjs'
import { C, KPI_KEY, N, READINESS_VOCAB, S, STATUS_COLOR, STATUS_LABELS_JSONATA, T, dashboard, donut, gauges, kpi, querySource, row, stackedBars, states, table, th } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const json = (file) => JSON.parse(readFileSync(join(here, file), 'utf8'))
const dag = json('dag.json')
/** Fixtures are build output (dump-fixtures.mts), so only the fixture build and --check need them. */
function loadFixtures() {
  const index = json('fixtures/index.json')
  return { now: Date.parse(index.now), responses: Object.fromEntries(Object.entries(index.files).map(([path, file]) => [path, json(`fixtures/${file}`)])) }
}

const STATE = '/v1/chain/state'
const ALERTS = '/v1/chain/alerts'
const TIMELINE = '/v1/chain/timeline?days=2'
const HISTORY = '/v1/chain/history?days=14'
const READINESS = '/v1/data-readiness'
const CAPACITY = '/v1/capacity'
const CLOCKS = '/v1/evidence-clocks'

/** The other chains, with the panel's long names shortened to fit a node. */
const SHORT = { 'active8-oof-weekly': 'Active-8 weekly', 'active8-oof-monthly': 'Active-8 monthly' }
const OTHER = Object.fromEntries(Object.entries(dag.other_chains).map(([id, chain]) => [id, { ...chain,
  stages: Object.fromEntries(Object.entries(chain.stages).map(([stageId, stage]) => [stageId, { ...stage, label: SHORT[stageId] ?? stage.label }])) }]))
/** The three small chains draw nodes of one size: grid columns per slot (weekly's 10 slots fill 16 columns; daily is 24 / 13). */
const COLS_PER_SLOT = 1.6
function lanePanel(title, id, x, y, w, h, q) {
  const slots = w / COLS_PER_SLOT
  if (slots < laneSlots(OTHER[id])) throw new Error(`${id} needs ${laneSlots(OTHER[id])} slots, ${w} columns give ${slots}`)
  return laneCanvas(title, q(`${STATE}?chain=${id}`, { root: CHAIN_PIVOT }), OTHER[id], x, y, w, h, slots)
}
const CHAIN_NAMES = JSON.stringify({ daily_readiness: '每日', intraday_guard: '盤中', weekly_research: '每週', monthly_artifact: '每月' })
/** Stage names (every chain) and daily chain order for responses that carry only stage_id. */
const NAMES = JSON.stringify(Object.fromEntries([...dag.catalog, ...Object.values(OTHER).flatMap((chain) => Object.entries(chain.stages).map(([id, stage]) => ({ id, label: stage.label })))]
  .map((stage) => [stage.id, stage.label])))
const ORDER = JSON.stringify(Object.fromEntries(dag.catalog.map((stage, position) => [stage.id, position])))
const CLOCK = 'time:MM/DD HH:mm'
/** Rows in chain order, oldest first within a stage: the state panels draw one row per stage in order of first appearance. */
const byChainOrder = (rows, time) => `$sort(${rows}, function($a, $b) {(
  $pa := $lookup(${ORDER}, $a.stage_id); $pb := $lookup(${ORDER}, $b.stage_id);
  $pa > $pb or ($pa = $pb and $a.${time} > $b.${time})
)})`

/** Readiness checks the Worker labels in English. */
const CHECK_NAMES = JSON.stringify({ price_freshness: '價格資料', chip_freshness: '籌碼資料', technical_indicator_freshness: '技術指標',
  market_dashboard_materialization: '首頁行情資料' })
/** Worst first: 缺漏, 遲到, 未到, 正常 (both vocabularies, see READINESS_VOCAB). */
const READINESS_RANK = JSON.stringify({ fail: 0, blocked: 0, warn: 1, waiting: 1, pending: 2, running: 2, ready: 3, ok: 3 })
/** The home-page items (rows) and the freshness checks as one table; `only` filters both. */
function readinessTable(q, title, x, y, w, h, { only = 'true', empty, hide = [] } = {}) {
  const columns = [N('rank', '序'), S('label', '項目'), S('status', '狀態'), S('latest', '最新日期'), S('detail', '說明')]
  return table(title, [
    q(READINESS, { root: `rows[${only}].{ 'rank': $lookup(${READINESS_RANK}, status), 'label': label, 'status': status, 'latest': latestDate,
      'detail': value & '；' & detail }`, columns, refId: 'A' }),
    q(READINESS, { root: `checks[${only}].{ 'rank': $lookup(${READINESS_RANK}, status), 'label': ($n := $lookup(${CHECK_NAMES}, id); $n ? $n : label),
      'status': status, 'latest': latest_date, 'detail': summary }`, columns, refId: 'B' }),
  ], x, y, w, h, { status: ['狀態'], vocabulary: READINESS_VOCAB, sort: '序', hide: ['序', ...hide], wd: { 狀態: 64, 最新日期: 100 }, empty })
}

const ACTIVE_ROWS = 'rows[active = true and optional = false and sub_stage != true and eta_margin_min != null]'
function marginTable(q, title, x, y, w, h, { hide = [] } = {}) {
  return table(title, q(STATE, { root: `$sort(${ACTIVE_ROWS}, function($a, $b) { $a.eta_margin_min > $b.eta_margin_min }).{ 'stage': label, 'eta': eta,
    'due': expected_by, 'margin': eta_margin_min }`, columns: [S('stage', '階段'), T('eta', '預估完成'), T('due', '截止'), N('margin', '餘裕')] }), x, y, w, h,
  { num: { 餘裕: [[C.bad, null], [C.warn, 0], [C.ok, 15]] }, unit: { 餘裕: 'm', 預估完成: CLOCK, 截止: CLOCK }, wd: { 預估完成: 92, 截止: 92, 餘裕: 64 }, hide,
    empty: '沒有可估算的未完成必要階段', desc: '預估＝這條鏈的起點＋該階段近 14 天的典型完成時間（至少 3 天樣本），不早於現在；樣本不足的階段不列。負值＝預估會超過截止。' })
}

/** Slice name → [statuses, colour]: the chain panel's legend words, plus 略過 (the Worker counts it as done in required_done). */
const STAGE_SLICES = [
  ['完成', ['completed', 'success', 'noop', 'retry_success'], C.ok], ['略過', ['skipped'], C.skip], ['執行中', ['running', 'waiting'], C.run],
  ['未開始', ['not_started', 'pending', 'out_of_window', 'stale'], C.idle], ['逾時／趕不上截止', ['overdue', 'at_risk', 'attention'], C.warn],
  ['失敗／中止', ['failed', 'error', 'stuck', 'missed', 'blocked'], C.bad]]
const sliceCounts = (rows, field) => `($r := ${rows}; { ${STAGE_SLICES.map(([name, statuses]) => `'${name}': $count($r[${field} in ${JSON.stringify(statuses)}])`).join(', ')} })`
const sliceColumns = () => STAGE_SLICES.map(([name]) => N(name, name))
const sliceColours = () => STAGE_SLICES.map(([name, , colour]) => [name, colour])

/** Page ①: should anything be done right now. */
function today(q) {
  const state = (root, columns, refId) => q(STATE, { root, columns, refId })
  const active = 'current[active = true]'
  return [
    verdict(q, 0, 0, 4, 3),
    kpi('現在這條鏈（業務日＝收盤日；盤前與驗證在次一交易日完成）；要處理／逾時／卡住／漏跑＝四條鏈合計', [
      state(`${active}.{ 'k': 1, 'date': business_date, 'done': $string(required_done) & '／' & $string(required_total), 'failed': failed,
        'elapsed': elapsed_min,
        'reported': $max($$.rows[active = true and updated_at != null].$toMillis(updated_at)) }`,
        [KPI_KEY, S('date', '業務日'), S('done', '必要階段完成'), N('failed', '失敗階段'), N('elapsed', '已執行'), N('reported', '最後回報')], 'A'),
      q(ALERTS, { root: `$merge([counts, { 'k': 1 }])`, columns: [KPI_KEY, N('total', '要處理'), N('overdue', '逾時'), N('stuck', '卡住'), N('missed', '漏跑')], refId: 'B' }),
    ], 4, 0, 20, 3, [
      { name: '失敗階段', th: th([C.txt, null], [C.bad, 1]) }, { name: '已執行', unit: 'm' },
      { name: '最後回報', unit: 'dateTimeFromNow' },
      { name: '要處理', th: th([C.txt, null], [C.bad, 1]) }, { name: '逾時', th: th([C.txt, null], [C.warn, 1]) },
      { name: '卡住', th: th([C.txt, null], [C.bad, 1]) }, { name: '漏跑', th: th([C.txt, null], [C.bad, 1]) },
    ]),
    table('要處理（四條鏈；次數＝近 14 天第幾次失敗）', q(ALERTS, {
      root: `rows.{ 'chain': $lookup(${CHAIN_NAMES}, chain_id), 'date': business_date, 'stage': $lookup(${NAMES}, stage_id), 'kind': kind, 'minutes': minutes,
        'times': failures_14d, 'error': error ? error : summary }`,
      columns: [S('chain', '鏈'), S('date', '業務日'), S('stage', '階段'), S('kind', '狀況'), N('minutes', '已持續'), N('times', '14 天次數'), S('error', '錯誤')] }),
      0, 3, 11, 8, { status: ['狀況'], num: { '14 天次數': [[C.txt, null], [C.bad, 2]] }, unit: { 已持續: 'm' }, wd: { 鏈: 48, 業務日: 104, 狀況: 64, 已持續: 84, '14 天次數': 88 },
        empty: '沒有需要處理的事項' }),
    donut('必要階段：現在各是什麼狀態', state(sliceCounts('rows[active = true and optional = false and sub_stage != true]', 'display_status'), sliceColumns()),
      11, 3, 6, 8, sliceColours()),
    marginTable(q, '未完成的必要階段：離截止還剩多久（最緊的在上）', 17, 3, 7, 8, { hide: ['截止'] }),
    chainCanvas('流程鏈（由左到右＝先後；粗框＝必要階段，細框＝只看失敗的階段）', state(CHAIN_PIVOT), dag, 0, 11, 24, 13),
    states('state-timeline', '近 24 小時各階段實際起訖', q(TIMELINE, {
      root: `${byChainOrder('rows', 'transition_at')}.{ 'time': transition_at, 'stage': $lookup(${NAMES}, stage_id), 'status': to_status }`,
      columns: [T('time', 'time'), S('stage', 'stage'), S('status', 'status')] }), 'stage', 0, 24, 14, 16),
    readinessTable(q, '資料就緒（有問題的排最上面）', 14, 24, 10, 16),
    row('階段明細（進行中那條鏈的每一站）', 40, [
      table('階段明細', state(
        `rows[active = true].{ 'stage': label, 'status': display_status, 'started': started_at, 'done': completed_at, 'took': started_at and completed_at
          ? $floor(($toMillis(completed_at) - $toMillis(started_at)) / 60000) : null, 'due': expected_by, 'eta': eta, 'attempt': attempt, 'note': error ? error : summary }`,
        [S('stage', '階段'), S('status', '狀態'), T('started', '開始'), T('done', '完成'), N('took', '耗時'), T('due', '截止'), T('eta', '預估完成'), N('attempt', '嘗試'),
          S('note', '摘要／錯誤')]),
        0, 41, 24, 16, { status: ['狀態'], unit: { 開始: CLOCK, 完成: CLOCK, 截止: CLOCK, 預估完成: CLOCK, 耗時: 'm' }, wd: { 狀態: 90, 耗時: 72, 嘗試: 56 } }),
    ]),
  ]
}

const HISTORIES = Object.entries(JSON.parse(CHAIN_NAMES)).map(([id, name]) => [id === 'daily_readiness' ? HISTORY : `${HISTORY}&chain=${id}`, name])
/** History results are the raw ChainStatus: blocked (the chain aborted there) counts as a failure. */
const FAILED = `result in ['error', 'blocked']`
const FINISHED = `result in ['success', 'retry_success', 'error', 'blocked']`

/** Page ②: where the chains broke over the last 14 days. */
function quality(q) {
  const [daily, intraday] = HISTORIES
  const perDay = ([path, name], refId) => q(path, { root: `$sort($distinct(rows.business_date)).($d := $; { 'date': $d, 'n': $count($$.rows[business_date = $d and ${FAILED}]) })`,
    columns: [S('date', 'date'), N('n', `${name}鏈`)], refId })
  const rate = ([path, name], refId) => q(path, { root: `{ 'k': 1, 'r': $count(rows[${FINISHED}]) ? $count(rows[${FINISHED} and $not(${FAILED})]) / $count(rows[${FINISHED}]) : null }`,
    columns: [KPI_KEY, N('r', `${name}鏈成功率`)], refId })
  return [
    kpi('近期成功率（跑完的站裡沒失敗的比例）與重複失敗（近期失敗 2 次以上的階段數）', [
      rate(daily, 'A'), rate(intraday, 'B'),
      ...HISTORIES.map(([path, name], i) => q(path, { root: `{ 'k': 1, 'n': $count(repeat_failures[failures >= 2]) }`, columns: [KPI_KEY, N('n', `${name}鏈重複失敗`)], refId: 'CDEF'[i] })),
    ], 0, 0, 24, 3, [
      ...[daily, intraday].map(([, name]) => ({ name: `${name}鏈成功率`, unit: 'percentunit', dec: 1, th: th([C.bad, null], [C.warn, 0.9], [C.ok, 0.97]) })),
      ...HISTORIES.map(([, name]) => ({ name: `${name}鏈重複失敗`, th: th([C.txt, null], [C.bad, 1]) })),
    ]),
    stackedBars('每個業務日失敗或中止幾站（每日鏈＋盤中鏈）', [perDay(daily, 'A'), perDay(intraday, 'B')], 'date', 0, 3, 15, 8,
      [['每日鏈', C.bad], ['盤中鏈', C.warn]]),
    donut('每日鏈近 14 天各站結果', q(HISTORY, { root: `{ '完成': $count(rows[result = 'success']), '重試後完成': $count(rows[result = 'retry_success']),
      '失敗／中止': $count(rows[${FAILED}]), '略過': $count(rows[result = 'skipped']), '未完成': $count(rows[result in ['pending', 'running']]) }`,
    columns: ['完成', '重試後完成', '失敗／中止', '略過', '未完成'].map((name) => N(name, name)) }), 15, 3, 9, 8,
    [['完成', C.ok], ['重試後完成', STATUS_COLOR('retry_success', 'text')], ['失敗／中止', C.bad], ['略過', C.skip], ['未完成', C.idle]]),
    states('status-history', '每日鏈每個階段近 14 天的最終結果（一格＝一個業務日）', q(HISTORY, {
      root: `${byChainOrder('rows', 'time')}.{ 'time': time, 'stage': label, 'result': result }`, columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')] }),
      'stage', 0, 11, 14, 14, { opts: { colWidth: 0.92 } }),
    // One query per chain, rows stacked: daily and intraday cover 14 days, weekly its last 5 periods, monthly 3.
    table('近期失敗過的階段（每日／盤中＝14 天，每週＝5 週，每月＝3 個月；2 次以上＝重複失敗）', HISTORIES.map(([path, name], i) =>
      q(path, {
        root: `repeat_failures.{ 'chain': '${name}', 'stage': label, 'failures': failures, 'dates': dates, 'error': last_error }`,
        columns: [S('chain', '鏈'), S('stage', '階段'), N('failures', '失敗次數'), S('dates', '失敗的業務日'), S('error', '最後一次的錯誤')], refId: 'ABCD'[i] })),
      14, 11, 10, 14, { num: { 失敗次數: [[C.txt, null], [C.bad, 2]] }, wd: { 鏈: 48, 失敗次數: 88, 失敗的業務日: 180 }, sort: '失敗次數', desc_sort: true,
        empty: '近期沒有失敗' }),
    lanePanel('每週研究（業務日＝該週週五；週五晚到週日跑；下排＝選配）', 'weekly_research', 0, 25, 16, 6, q),
    lanePanel('每月 artifact（業務日＝每月第一個週六）', 'monthly_artifact', 16, 25, 8, 6, q),
    lanePanel('盤中守門（交易日 09:00–13:30；下排＝獨立排程的重新評分）', 'intraday_guard', 0, 31, 11, 6, q),
    states('status-history', '盤中鏈每個階段近 14 天的最終結果', q(intraday[0], {
      root: `$sort(rows, function($a, $b) { $a.position > $b.position or ($a.position = $b.position and $a.time > $b.time) }).{ 'time': time, 'stage': label, 'result': result }`,
      columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')] }), 'stage', 11, 31, 13, 6, { opts: { colWidth: 0.92 } }),
  ]
}

/** [title words, colour] for the Google Cloud stats, first match wins. */
const GCP_TONES = [[['失敗'], C.bad], [['錯誤'], C.warn], [['成功'], C.ok], [['執行中'], C.run]]

/** Cloud Run / Scheduler over Google Cloud Monitoring (already live; not part of the fixture), from y. Counts per job are
 * donuts and the job outcomes bars per rolling 24 hours (Cloud Monitoring aligns to the query end, not calendar days). */
function gcpPanels(y) {
  const source = json('../dashboards/gcp-cloud-run-scheduler.json').panels
  const pick = (title) => { const { id, gridPos, ...panel } = source.find((p) => p.title === title); return structuredClone(panel) }
  const at = (panel, x, py, w, h, extra = {}) => ({ ...panel, gridPos: { x, y: y + py, w, h }, ...extra })
  const stats = ['Cloud Run Job 失敗次數（所選時間）', 'Cloud Run Job 成功次數（所選時間）', 'Scheduler 錯誤日誌（所選時間）', '目前執行中的 Job'].map((title, i) => {
    const panel = pick(title)
    panel.options = { ...panel.options, colorMode: 'value', graphMode: 'none', textMode: 'value', text: { titleSize: 12, valueSize: 20 } }
    const tone = GCP_TONES.find(([words]) => words.every((word) => title.includes(word)))?.[1]
    const steps = tone !== C.ok && tone !== C.run ? th([C.txt, null], [tone, 1]) : th([tone, null])
    panel.fieldConfig = { ...panel.fieldConfig, defaults: { ...panel.fieldConfig?.defaults, color: { mode: 'thresholds' }, thresholds: steps } }
    return at({ ...panel, title,
      description: 'Google Cloud Monitoring 原生數字，含設計性重試（例如 watchdog 先失敗再成功）。' }, i * 6, 0, 6, 3)
  })
  const outcome = (title, alias) => { const target = structuredClone(pick(title).targets[0]); target.timeSeriesList.alignmentPeriod = '+86400s'; return { ...target, aliasBy: alias } }
  const daily = { type: 'timeseries', title: 'Cloud Run Job 每 24 小時成功／失敗次數（所選時間）', datasource: source[0].datasource,
    targets: [{ ...outcome('Cloud Run Job 成功次數（所選時間）', '成功'), refId: 'A' }, { ...outcome('Cloud Run Job 失敗次數（所選時間）', '失敗'), refId: 'B' }],
    options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: ['sum'] }, tooltip: { mode: 'multi' } },
    fieldConfig: { defaults: { unit: 'none', decimals: 0, min: 0, custom: { drawStyle: 'bars', barAlignment: 0, fillOpacity: 85, lineWidth: 0, stacking: { mode: 'normal' } } },
      overrides: [['A', C.ok], ['B', C.bad]].map(([refId, color]) => ({ matcher: { id: 'byFrameRefID', options: refId }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } }
  const perJob = (title, newTitle) => { const panel = pick(title); return { ...panel, type: 'piechart', title: newTitle,
    options: { pieType: 'donut', reduceOptions: { values: false, calcs: ['sum'], fields: '' }, displayLabels: [], tooltip: { mode: 'single' },
      legend: { showLegend: true, displayMode: 'table', placement: 'right', values: ['value'] } },
    fieldConfig: { defaults: { unit: 'none', decimals: 0, noValue: '沒有', color: { mode: 'palette-classic' } }, overrides: [] } } }
  return [
    ...stats,
    at(daily, 0, 3, 12, 8),
    at(perJob('各 Job 失敗次數（所選時間）', '失敗集中在哪些 Job（所選時間）'), 12, 3, 6, 8),
    at(perJob('各 Scheduler job 錯誤日誌（所選時間）', 'Scheduler 錯誤集中在哪些 job（所選時間）'), 18, 3, 6, 8),
    at(pick('執行中的 Job（依 job）'), 0, 11, 24, 7),
    at(pick('Cloud Run 服務請求（依回應類別）'), 0, 18, 12, 7),
    at(pick('Cloud Run 服務延遲 p95'), 12, 18, 12, 7),
  ]
}

/** Page ③: storage, Google Cloud and the evidence the models are collecting. */
function resources(q) {
  const endpoints = [[STATE, '流程鏈狀態'], [ALERTS, '要處理'], [TIMELINE, '起訖'], [HISTORY, '14 天結果'], [READINESS, '資料就緒'], [CAPACITY, '容量'], [CLOCKS, 'evidence clocks']]
  const gcp = gcpPanels(18)
  const bottom = Math.max(...gcp.map((p) => p.gridPos.y + p.gridPos.h))
  return [
    kpi('D1 容量（單庫上限 10 GB；80% 注意、90% 硬門檻）', [q(CAPACITY, { root: `{ 'pct': $max(rows.utilization_pct), 'days': $min(rows[projected_days_to_critical_90pct != null].projected_days_to_critical_90pct),
      'count': $count(rows), 'at': $toMillis(generated_at) }`, columns: [N('pct', '最高使用率'), N('days', '最快到 90%'), N('count', '資料庫數'), N('at', '容量快照')] })], 0, 0, 24, 3, [
      { name: '最高使用率', unit: 'percent', dec: 1, th: th([C.txt, null], [C.warn, 80], [C.bad, 90]) },
      { name: '最快到 90%', unit: 'suffix: 天', th: th([C.bad, null], [C.warn, 30], [C.txt, 90]), mappings: [{ type: 'special', options: { match: 'null', result: { text: '不會到' } } }] },
      { name: '資料庫數', th: th([C.warn, null], [C.txt, 8], [C.warn, 9]) }, { name: '容量快照', unit: 'dateTimeFromNow' },
    ]),
    gauges('各資料庫使用率', q(CAPACITY, { root: `rows.{ 'db': binding_name, 'pct': utilization_pct }`, columns: [S('db', 'db'), N('pct', 'pct')] }), 'db', 0, 3, 10, 7),
    table('D1 容量與成長', q(CAPACITY, {
      root: `rows.{ 'db': binding_name, 'pct': utilization_pct, 'gb': used_bytes / 1000000000, 'growth': daily_growth_bytes / 1000000,
        'd65': projected_days_to_warning_65pct, 'd90': projected_days_to_critical_90pct, 'status': status }`,
      columns: [S('db', '資料庫'), S('status', '狀態'), N('pct', '使用率'), N('gb', '已用'), N('growth', '每日成長'), N('d65', '到 65% 天數'), N('d90', '到 90% 天數')] }),
      10, 3, 14, 7, { status: ['狀態'], num: { 使用率: [[C.ok, null], [C.warn, 80], [C.bad, 90]], '到 90% 天數': [[C.bad, null], [C.warn, 30], [C.txt, 90]] },
        unit: { 使用率: 'percent', 已用: 'decgbytes', 每日成長: 'decmbytes' }, wd: { 狀態: 64 }, sort: '使用率', desc_sort: true }),
    kpi('真實與 paper 下單意圖對得上幾筆（execution parity）；RFS allocator 證據累積', [
      q(CLOCKS, { root: `$merge([details.execution_parity, { 'k': 1 }])`, columns: [KPI_KEY, N('real_intents', '真實意圖'), N('paper_intents', 'paper 意圖'), N('matched_intents', '對得上')], refId: 'A' }),
      q(CLOCKS, { root: `$merge([details.rfs_allocator, { 'k': 1 }])`, columns: [KPI_KEY, N('candidate_count', '候選數'), N('blocked_receipts', '被擋的收據'),
        N('mature_5_session_dates', '滿 5 日'), N('mature_20_session_dates', '滿 20 日')], refId: 'B' }),
    ], 0, 10, 24, 3, [{ name: '真實意圖' }, { name: 'paper 意圖' }, { name: '對得上' }, { name: '候選數' }, { name: '被擋的收據', th: th([C.txt, null], [C.warn, 1]) },
      { name: '滿 5 日' }, { name: '滿 20 日' }]),
    table('各機制的證據累積到哪、卡在哪（evidence clocks；只供比較，不影響下單）', q(CLOCKS, {
      root: `rows[mechanism != 'shadow_a'].{ 'label': label, 'status': status, 'latest': latest_evidence_date, 'samples': sample_count, 'dates': distinct_dates,
        'coverage': coverage, 'delta': incumbent_delta, 'lcb': confidence_bound, 'regimes': supported_regimes, 'blockers': blockers }`,
      columns: [S('label', '機制'), S('status', '狀態'), S('latest', '最新證據日'), N('samples', '樣本數'), N('dates', '天數'), N('coverage', '覆蓋率'),
        N('delta', '對現行差異'), N('lcb', '信賴下界'), S('regimes', '適用盤勢'), S('blockers', '卡在哪')] }), 0, 13, 24, 5,
      { status: ['狀態'], unit: { 覆蓋率: 'percentunit' }, wd: { 狀態: 170, 最新證據日: 110, 樣本數: 84, 天數: 70, 覆蓋率: 84, 對現行差異: 110, 信賴下界: 90, 適用盤勢: 110 } }),
    ...gcp,
    row('監控自己的讀取成本', bottom, [
      kpi('每個端點這次回應讀了幾列 D1（端點有快取，儀表板重新整理不會多讀）',
        endpoints.map(([path, name], i) => q(path, { root: `{ 'k': 1, 'n': rows_read }`, columns: [KPI_KEY, N('n', name)], refId: 'ABCDEFG'[i] })), 0, bottom + 1, 24, 3,
        endpoints.map(([, name]) => ({ name, th: th([C.txt, null], [C.warn, 1000], [C.bad, 20000]) }))),
    ]),
  ]
}

/** 2 = 停, 1 = 注意, 0 = 正常: each query returns its own level and the panel shows the highest. A query that fails
 * returns no field, so the level is shifted by 10 per missing answer: 10 and up reads 讀不到資料, never 正常. */
const VERDICT = [[0, '正常', C.ok], [1, '注意', C.warn], [2, '停', C.bad]]
const VERDICT_FIELDS = ['vA', 'vB', 'vC']
function verdict(q, x, y, w, h) {
  const level = (path, expr, refId) => q(path, { root: `{ 'k': 1, 'v': ${expr} }`, columns: [KPI_KEY, N('v', `v${refId}`)], refId })
  const targets = [
    level(STATE, `$count(rows[active = true and phase = 'premarket' and optional = false and display_status in ['failed', 'error', 'blocked', 'missed', 'stuck']]) > 0 ? 2 : 0`, 'A'),
    level(ALERTS, 'counts.total > 0 ? 1 : 0', 'B'),
    level(READINESS, `$count(checks[status = 'fail']) + $count(rows[status = 'blocked']) > 0 ? 1 : 0`, 'C'),
  ]
  const panel = kpi('今天能不能出手', targets, x, y, w, h, [])
  panel.description = '停＝每日鏈盤前段有必要階段失敗、漏跑或卡住；注意＝四條鏈有要處理的項目，或資料就緒有缺漏；其他＝正常。只讀監控資料，不影響下單。'
  const calc = (options) => ({ id: 'calculateField', options })
  const binary = (left, operator, right, alias, replaceFields = false) => calc({ mode: 'binary', binary: { left, operator, right }, alias, replaceFields })
  panel.transformations.push(
    calc({ mode: 'reduceRow', reduce: { reducer: 'max', include: VERDICT_FIELDS }, alias: 'max' }),
    calc({ mode: 'reduceRow', reduce: { reducer: 'count', include: VERDICT_FIELDS }, alias: 'answered' }),
    binary('answered', '*', '-10', 'missing'),
    binary('max', '+', 'missing', 'shifted'),
    binary('shifted', '+', String(VERDICT_FIELDS.length * 10), '判斷', true))
  panel.options = { ...panel.options, textMode: 'value', text: { titleSize: 12, valueSize: 20 } }
  panel.fieldConfig.defaults = { ...panel.fieldConfig.defaults, color: { mode: 'thresholds' },
    thresholds: th(...VERDICT.map(([value, , color]) => [color, value || null])),
    mappings: [{ type: 'value', options: Object.fromEntries(VERDICT.map(([value, label, color], index) => [value, { text: label, color, index }])) },
      { type: 'range', options: { from: 10, to: 1000, result: { text: '讀不到資料', color: C.bad, index: VERDICT.length } } }] }
  return panel
}

/** Phone layout: one column, conclusions first; Grafana stacks panels in gridPos order. */
function mobile(q) {
  return [
    verdict(q, 0, 0, 24, 3),
    table('要處理', q(ALERTS, {
      root: `rows.{ 'level': severity, 'item': $lookup(${CHAIN_NAMES}, chain_id) & '｜' & $lookup(${NAMES}, stage_id) & '｜' & $lookup(${STATUS_LABELS_JSONATA}, kind), 'due': expected_by }`,
      columns: [S('level', '級別'), S('item', '事項'), T('due', '期限')] }), 0, 3, 24, 6,
      { status: ['級別'], unit: { 期限: CLOCK }, wd: { 級別: 76, 期限: 100 }, empty: '沒有需要處理的事項' }),
    marginTable(q, '未完成的必要階段（離截止還剩多久）', 0, 9, 24, 8, { hide: ['截止'] }),
    readinessTable(q, '資料就緒：只列有問題的', 0, 17, 24, 5, { only: `status != 'ok' and status != 'ready'`, empty: '全部到齊', hide: ['最新日期'] }),
    table('失敗中的階段（次數＝近 14 天第幾次）', q(ALERTS, {
      root: `rows[kind = 'failed'].{ 'stage': $lookup(${CHAIN_NAMES}, chain_id) & '｜' & $lookup(${NAMES}, stage_id), 'times': failures_14d, 'error': error ? error : summary }`,
      columns: [S('stage', '階段'), N('times', '次數'), S('error', '錯誤')] }), 0, 22, 24, 6,
      { num: { 次數: [[C.txt, null], [C.bad, 2]] }, wd: { 次數: 56 }, empty: '沒有失敗中的階段' }),
  ]
}

const DESKTOP_LINKS = [['手機版', 'sv-mobile']]
const PAGES = [
  { uid: 'sv-today', title: 'StockVision 今天', build: today, live: { from: 'now-24h', to: 'now' }, hours: 24, refresh: '1m', links: DESKTOP_LINKS },
  { uid: 'sv-health', title: 'StockVision 執行品質', build: quality, live: { from: 'now-14d', to: 'now' }, hours: 14 * 24, refresh: '5m', links: DESKTOP_LINKS },
  { uid: 'sv-model', title: 'StockVision 資源與模型', build: resources, live: { from: 'now-7d', to: 'now' }, hours: 7 * 24, refresh: '5m', links: DESKTOP_LINKS },
  { uid: 'sv-mobile', title: 'SV 手機', build: mobile, live: { from: 'now-24h', to: 'now' }, hours: 24, refresh: '1m', links: [['看完整版', 'sv-today']], pageList: false },
]

function build(mode) {
  const fixtures = mode === 'fixture' ? loadFixtures() : null
  const q = querySource(mode, fixtures?.responses)
  const fixtureNow = fixtures?.now
  return PAGES.map((page) => dashboard(mode === 'live'
    ? { uid: page.uid, title: page.title, panels: page.build(q), time: page.live, refresh: page.refresh, links: page.links, pageList: page.pageList }
    : { uid: `${page.uid}-fixture`, title: `${page.title}（未接線：測試夾具資料，不是 prod）`, panels: page.build(q), tag: 'stockvision-fixture',
        links: page.links.map(([title, uid]) => [title, `${uid}-fixture`]), pageList: page.pageList,
        // Fixture data is a snapshot of one evening, so the page is pinned to that evening.
        time: { from: new Date(fixtureNow - page.hours * 3600_000).toISOString(), to: new Date(fixtureNow).toISOString() } }))
}

/** A panel with everything that may differ between the two modes removed. */
function comparable(board) {
  const strip = (target) => { const { datasource, source, url, url_options, data, ...rest } = target; return rest }
  const panel = (p) => ({ ...p, datasource: undefined, targets: p.targets?.map(strip), panels: p.panels?.map(panel) })
  return JSON.stringify(board.panels.map(panel))
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const live = build('live'); const fixture = build('fixture')
  const differing = live.filter((board, i) => comparable(board) !== comparable(fixture[i])).map((board) => board.uid)
  if (differing.length) { console.error(`live and fixture panels differ: ${differing.join(', ')}`); process.exit(1) }
  console.log(`${live.length} dashboards: live and fixture differ only in the query source`)
} else {
  const mode = args[args.indexOf('--mode') + 1]
  if (!['live', 'fixture'].includes(mode)) { console.error('usage: build.mjs --mode live|fixture | --check'); process.exit(2) }
  const out = join(here, '..', 'dashboards', mode === 'fixture' ? 'fixture' : '')
  mkdirSync(out, { recursive: true })
  for (const board of build(mode)) {
    writeFileSync(join(out, `${board.uid}.json`), `${JSON.stringify(board, null, 1)}\n`)
    console.log(`${mode}: ${board.uid} (${board.panels.length} panels)`)
  }
}
