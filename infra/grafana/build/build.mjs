#!/usr/bin/env node
/** Builds the StockVision dashboards.
 *   node build.mjs --mode live     → ../dashboards/*.json            (queries the monitoring Worker)
 *   node build.mjs --mode fixture  → ../dashboards/fixture/*.json    (the same panels over fixtures/*.json)
 *   node build.mjs --check         → fails unless both modes differ only in where a query reads from
 * Fixtures and dag.json come from dump-fixtures.mts and export-dag.mts. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chainCanvas, CHAIN_PIVOT } from './canvas.mjs'
import { C, KPI_KEY, N, S, T, bars, dashboard, kpi, querySource, row, states, statusMappings, table, text, th } from './lib.mjs'

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

/** Stage names and chain order for responses that carry only stage_id. */
const NAMES = JSON.stringify(Object.fromEntries(dag.catalog.map((stage) => [stage.id, stage.label])))
const ORDER = JSON.stringify(Object.fromEntries(dag.catalog.map((stage, position) => [stage.id, position])))
const CLOCK = 'time:MM/DD HH:mm'
/** Rows in chain order, oldest first within a stage: the state panels draw one row per stage in order of first appearance. */
const byChainOrder = (rows, time) => `$sort(${rows}, function($a, $b) {(
  $pa := $lookup(${ORDER}, $a.stage_id); $pb := $lookup(${ORDER}, $b.stage_id);
  $pa > $pb or ($pa = $pb and $a.${time} > $b.${time})
)})`

function today(q) {
  const state = (root, columns, refId) => q(STATE, { root, columns, refId })
  const active = 'current[active = true]'
  return [
    kpi('現在這條鏈（業務日＝收盤日；盤前與驗證在次一交易日完成）', [
      state(`${active}.{ 'k': 1, 'date': business_date, 'done': $string(required_done) & '／' & $string(required_total), 'failed': failed,
        'elapsed': elapsed_min, 'margin': worst_margin_min, 'tight': worst_margin_stage ? $lookup(${NAMES}, worst_margin_stage) : '—' }`,
        [KPI_KEY, S('date', '業務日'), S('done', '必要階段完成'), N('failed', '失敗階段'), N('elapsed', '已執行'), N('margin', '最緊的餘裕'), S('tight', '最緊的階段')], 'A'),
      q(ALERTS, { root: `$merge([counts, { 'k': 1 }])`, columns: [KPI_KEY, N('total', '要處理'), N('overdue', '逾時'), N('stuck', '卡住'), N('missed', '漏跑')], refId: 'B' }),
    ], 0, 0, 24, 3, [
      { name: '失敗階段', th: th([C.txt, null], [C.bad, 1]) }, { name: '已執行', unit: 'm' },
      { name: '最緊的餘裕', unit: 'm', th: th([C.bad, null], [C.retry, 0], [C.txt, 15]) },
      { name: '要處理', th: th([C.txt, null], [C.bad, 1]) }, { name: '逾時', th: th([C.txt, null], [C.warn, 1]) },
      { name: '卡住', th: th([C.txt, null], [C.stuck, 1]) }, { name: '漏跑', th: th([C.txt, null], [C.bad, 1]) },
    ]),
    chainCanvas('流程鏈（由左到右＝先後；粗框＝必要階段，細框＝只看失敗的階段）', state(CHAIN_PIVOT), dag, 0, 3, 24, 13),
    states('state-timeline', '近 24 小時各階段實際起訖', q(TIMELINE, {
      root: `${byChainOrder('rows', 'transition_at')}.{ 'time': transition_at, 'stage': $lookup(${NAMES}, stage_id), 'status': to_status }`,
      columns: [T('time', 'time'), S('stage', 'stage'), S('status', 'status')] }), 'stage', 0, 16, 14, 17, { opts: { rowHeight: 0.85 } }),
    table('要處理（全綠時是空的；次數＝近 14 天第幾次失敗）', q(ALERTS, {
      root: `rows.{ 'date': business_date, 'stage': $lookup(${NAMES}, stage_id), 'kind': kind, 'minutes': minutes, 'times': failures_14d, 'error': error ? error : summary }`,
      columns: [S('date', '業務日'), S('stage', '階段'), S('kind', '狀況'), N('minutes', '已持續'), N('times', '14 天次數'), S('error', '錯誤')] }),
      14, 16, 10, 6, { status: ['狀況'], num: { '14 天次數': [[C.txt, null], [C.bad, 2]] }, unit: { 已持續: 'm' }, wd: { 業務日: 104, 狀況: 64, 已持續: 84, '14 天次數': 88 } }),
    bars('還沒完成的必要階段：預估完成到截止還剩幾分鐘（最緊的在上）', state(
      `$sort(rows[active = true and eta_margin_min != null], function($a, $b) { $a.eta_margin_min > $b.eta_margin_min }).{ 'stage': label, 'margin': eta_margin_min }`,
      [S('stage', 'stage'), N('margin', 'margin')]), 'margin', 14, 22, 10, 11,
      { mode: 'basic', unit: 'm', max: 600, th: th([C.bad, null], [C.retry, 0], [C.ok, 15]),
        desc: '預估＝這條鏈的起點＋該階段近 14 天的典型完成時間（至少 3 天樣本），不早於現在。' }),
    table('資料就緒', q(READINESS, {
      root: `rows.{ 'label': label, 'status': status, 'value': value, 'latest': latestDate, 'detail': detail }`,
      columns: [S('label', '項目'), S('status', '狀態'), S('value', '筆數'), S('latest', '最新日期'), S('detail', '說明')] }),
      0, 33, 14, 9, { status: ['狀態'], wd: { 狀態: 64, 筆數: 90, 最新日期: 100 } }),
    table('資料新鮮度檢查', q(READINESS, {
      root: `checks.{ 'label': label, 'status': status, 'latest': latest_date, 'lag': lag_days, 'rows': rows_on_latest }`,
      columns: [S('label', '項目'), S('status', '狀態'), S('latest', '最新日期'), N('lag', '落後天數'), N('rows', '當日列數')] }),
      14, 33, 10, 9, { status: ['狀態'], num: { 落後天數: [[C.txt, null], [C.warn, 1], [C.bad, 3]] }, wd: { 狀態: 64 } }),
    row('階段明細（進行中那條鏈的每一站）', 42, [
      table('階段明細', state(
        `rows[active = true].{ 'stage': label, 'status': display_status, 'started': started_at, 'done': completed_at, 'due': expected_by, 'eta': eta,
          'attempt': attempt, 'note': error ? error : summary }`,
        [S('stage', '階段'), S('status', '狀態'), T('started', '開始'), T('done', '完成'), T('due', '截止'), T('eta', '預估完成'), N('attempt', '嘗試'), S('note', '摘要／錯誤')]),
        0, 43, 24, 16, { status: ['狀態'], unit: { 開始: CLOCK, 完成: CLOCK, 截止: CLOCK, 預估完成: CLOCK }, wd: { 狀態: 90, 嘗試: 56 } }),
    ]),
  ]
}

/** Cloud Run / Scheduler panels over Google Cloud Monitoring (already live; not part of the fixture). */
function gcpPanels(y) {
  const source = json('../dashboards/gcp-cloud-run-scheduler.json').panels
  const top = Math.min(...source.map((p) => p.gridPos.y))
  // The source dashboard's stats are tall coloured tiles; here they are one compact strip like the other numbers.
  const STAT_H = 3
  const saved = Math.max(...source.filter((p) => p.type === 'stat').map((p) => p.gridPos.h)) - STAT_H
  return source.map((p) => {
    const stat = p.type === 'stat'
    const panel = { ...p, gridPos: { ...p.gridPos, y: y + p.gridPos.y - top - (stat ? 0 : saved), h: stat ? STAT_H : p.gridPos.h } }
    delete panel.id
    if (stat) panel.options = { ...panel.options, colorMode: 'value', graphMode: 'none', textMode: 'value', text: { titleSize: 12, valueSize: 20 } }
    if (panel.type === 'bargauge') panel.options = { ...panel.options, text: { titleSize: 12, valueSize: 13 } }
    return panel
  })
}

function health(q) {
  const endpoints = [[STATE, '流程鏈狀態'], [ALERTS, '要處理'], [TIMELINE, '起訖'], [HISTORY, '14 天結果'], [READINESS, '資料就緒'], [CAPACITY, '容量'], [CLOCKS, 'evidence clocks']]
  return [
    states('status-history', '每個階段近 14 天的最終結果（一格＝一個業務日）', q(HISTORY, {
      root: `${byChainOrder('rows', 'time')}.{ 'time': time, 'stage': label, 'result': result }`, columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')] }),
      'stage', 0, 0, 24, 13, { opts: { rowHeight: 0.85, colWidth: 0.92 } }),
    table('14 天內失敗過的階段（2 次以上＝重複失敗）', q(HISTORY, {
      root: `repeat_failures.{ 'stage': label, 'failures': failures, 'dates': dates, 'error': last_error }`,
      columns: [S('stage', '階段'), N('failures', '失敗次數'), S('dates', '失敗的業務日'), S('error', '最後一次的錯誤')] }),
      0, 13, 12, 7, { num: { 失敗次數: [[C.txt, null], [C.bad, 2]] }, wd: { 失敗次數: 76, 失敗的業務日: 180 } }),
    table('資料庫容量與成長（D1 單庫上限 10 GB）', q(CAPACITY, {
      root: `rows.{ 'db': binding_name, 'pct': utilization_pct, 'gb': used_bytes / 1000000000, 'growth': daily_growth_bytes / 1000000,
        'd65': projected_days_to_warning_65pct, 'd90': projected_days_to_critical_90pct }`,
      columns: [S('db', '資料庫'), N('pct', '使用率'), N('gb', '已用'), N('growth', '每日成長'), N('d65', '到 65% 天數'), N('d90', '到 90% 天數')] }),
      12, 13, 12, 7, { gauge: { 使用率: { max: 100, unit: 'percent', th: th([C.ok, null], [C.retry, 65], [C.bad, 90]) } },
        num: { '到 90% 天數': [[C.bad, null], [C.retry, 30], [C.txt, 90]] }, unit: { 已用: 'decgbytes', 每日成長: 'decmbytes' }, sort: '使用率', desc_sort: true }),
    kpi('監控自己的讀取成本：每個端點這次回應讀了幾列 D1（端點有快取，儀表板重新整理不會多讀）',
      endpoints.map(([path, name], i) => q(path, { root: `{ 'k': 1, 'n': rows_read }`, columns: [KPI_KEY, N('n', name)], refId: 'ABCDEFG'[i] })), 0, 20, 24, 3,
      endpoints.map(([, name]) => ({ name, th: th([C.txt, null], [C.retry, 1000], [C.bad, 20000]) }))),
    ...gcpPanels(23),
  ]
}

/** What the model page still lacks a source for; each is listed in infra/grafana/README.md. */
const MODEL_PENDING = ['Paper NAV 對加權指數、回撤', '各模型 rolling 20d IC、模型名冊', '每日訊號檔數（強度分段）、T+5 實現報酬', 'OPB 各 arm 被選比例', '每日訓練耗時']

function model(q) {
  const parity = `details.execution_parity`
  return [
    table('Evidence clocks：各機制累積到哪、卡在哪（只供比較，不影響下單）', q(CLOCKS, {
      root: `rows.{ 'label': label, 'status': status, 'latest': latest_evidence_date, 'samples': sample_count, 'dates': distinct_dates,
        'coverage': coverage, 'delta': incumbent_delta, 'blockers': blockers }`,
      columns: [S('label', '機制'), S('status', '狀態'), S('latest', '最新證據日'), N('samples', '樣本數'), N('dates', '天數'), N('coverage', '覆蓋率'),
        N('delta', '對現行差異'), S('blockers', '卡在哪')] }), 0, 0, 24, 6, { status: ['狀態'], unit: { 覆蓋率: 'percentunit' }, wd: { 狀態: 170, 最新證據日: 110, 樣本數: 84, 天數: 70, 覆蓋率: 84, 對現行差異: 110 } }),
    kpi('Execution parity：真實與 paper 下單意圖對得上幾筆', [q(CLOCKS, { root: parity,
      columns: [N('real_intents', '真實意圖'), N('paper_intents', 'paper 意圖'), N('matched_intents', '對得上')] })], 0, 6, 12, 3,
      [{ name: '真實意圖' }, { name: 'paper 意圖' }, { name: '對得上' }]),
    text(`**還沒有資料來源、所以沒放的面板**\n\n${MODEL_PENDING.map((item) => `- ${item}`).join('\n')}\n\n來源調查結果與先後順序見 \`infra/grafana/README.md\`。`, 12, 6, 12, 5),
  ]
}

const PAGES = [
  { uid: 'sv-today', title: 'StockVision 今天', build: today, live: { from: 'now-24h', to: 'now' }, hours: 24, refresh: '1m' },
  { uid: 'sv-health', title: 'StockVision 健康', build: health, live: { from: 'now-14d', to: 'now' }, hours: 14 * 24, refresh: '5m' },
  { uid: 'sv-model', title: 'StockVision 模型', build: model, live: { from: 'now-30d', to: 'now' }, hours: 30 * 24, refresh: '' },
]

function build(mode) {
  const fixtures = mode === 'fixture' ? loadFixtures() : null
  const q = querySource(mode, fixtures?.responses)
  const fixtureNow = fixtures?.now
  return PAGES.map((page) => dashboard(mode === 'live'
    ? { uid: page.uid, title: page.title, panels: page.build(q), time: page.live, refresh: page.refresh }
    : { uid: `${page.uid}-fixture`, title: `${page.title}（未接線：測試夾具資料，不是 prod）`, panels: page.build(q), tag: 'stockvision-fixture',
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
