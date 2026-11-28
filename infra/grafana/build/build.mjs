#!/usr/bin/env node
/** Builds the StockVision dashboards.
 *   node build.mjs --mode live     → ../dashboards/*.json            (queries the monitoring Worker)
 *   node build.mjs --mode fixture  → ../dashboards/fixture/*.json    (the same panels over fixtures/*.json and mock.mjs)
 *   node build.mjs --check         → fails unless both modes differ only in where a query reads from
 *   node build.mjs --mode preview --out <dir>  → <dir>/<uid>-v4.json (the four desktop pages for the preview folder)
 *   node build.mjs --mode preview5 --out <dir> → <dir>/<uid>-v5.json (the v5 redesign, dashboard_rethink_v5.md)
 *   node build.mjs --mode preview5live --out <dir> → <dir>/<uid>-v5live.json (v5 ② ④ over the live monitoring Worker)
 *   node build.mjs --mode preview6live --out <dir> → <dir>/<uid>-v6live.json (v6 ① ② ④; routes not deployed yet over mock.mjs)
 * Fixtures and dag.json come from dump-fixtures.mts and export-dag.mts. A panel reading a Worker route this checkout
 * does not serve (or a source not wired yet) is planned: the fixture build draws it over mock.mjs, the live build leaves it out. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_FALLBACK, WATCHERS, chainCanvas, CHAIN_PIVOT, DOTS_PIVOT, laneCanvas, laneSlots, readinessCanvas, readinessPivot, SHORT_LABELS, slowPivot } from './canvas.mjs'
import { ALERT_KIND, BIGQUERY_DS, C, COOL, STATUS, TONE, GCP_DS, KPI_KEY, N, NO_SOURCE, READINESS_VOCAB, S, STATUS_LABELS_JSONATA, T, dashboard, donut, gauges, gp, grid, hbars, heatmap, kpi, lcd,
  querySource, spark, stackedBars, states, statusMappings, table, th } from './lib.mjs'
import { mockResponses } from './mock.mjs'
import { rawErrorHits } from './rawErrors.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const json = (file) => JSON.parse(readFileSync(join(here, file), 'utf8'))
const dag = json('dag.json')
const DAY_MS = 86_400_000
/** Every date in a response moved by whole days; timestamps keep their time of day. */
const shiftDates = (value, days) => (days ? JSON.parse(JSON.stringify(value).replace(/\d{4}-[01]\d-[0-3]\d/g,
  (d) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10))) : value)
/** Fixtures are build output (dump-fixtures.mts), so only the fixture, preview and --check builds need them. `at`: move
 * the fixture evening forward by whole days to the last one before `at`, for pages on relative time. */
function loadFixtures(at) {
  const index = json('fixtures/index.json')
  const days = at ? Math.max(0, Math.floor((at - Date.parse(index.now)) / DAY_MS)) : 0
  const now = new Date(Date.parse(index.now) + days * DAY_MS).toISOString()
  const mock = mockResponses(now)
  return { now: Date.parse(now), demo: new Set(Object.keys(mock)),
    responses: { ...Object.fromEntries(Object.entries(index.files).map(([path, file]) => [path, shiftDates(json(`fixtures/${file}`), days)])), ...mock } }
}
/** Routes the monitoring Worker in this checkout serves. */
const LIVE_ROUTES = new Set([...readFileSync(join(here, '../../../worker/src/monitoring/index.ts'), 'utf8').matchAll(/^\s*'(\/v1\/[^']+)':/gm)].map((m) => m[1]))

const STATE = '/v1/chain/state'
const ALERTS = '/v1/chain/alerts'
/** An alert row's chain: rows carry chain_id once the Worker judges all four chains; until then only the response does. */
const ROW_CHAIN = 'chain_id ? chain_id : $$.chain_id'
const TIMELINE = '/v1/chain/timeline?days=14'
const HISTORY = '/v1/chain/history?days=14'
const READINESS = '/v1/data-readiness'
const CAPACITY = '/v1/capacity'
const CLOCKS = '/v1/evidence-clocks'
const NAV = '/v1/paper/nav?days=90'
const ROSTER = '/v1/models/roster'
const OPB = '/v1/opb?days=60'
const FAILURE_CLASSES = '/v1/chain/failure-classes?days=14'
const KV_DRIFT = '/v1/kv-drift'

/** The other chains, with the panel's long names shortened to fit a node. */
const OTHER = Object.fromEntries(Object.entries(dag.other_chains).map(([id, chain]) => [id, { ...chain,
  stages: Object.fromEntries(Object.entries(chain.stages).map(([stageId, stage]) => [stageId, { ...stage, label: SHORT_LABELS[stageId] ?? stage.label }])) }]))
/** The three small chains draw nodes of one size: grid columns per slot (weekly's 10 slots fill 16 columns; daily is 24 / 13). */
const COLS_PER_SLOT = 1.6
function lanePanel(title, id, x, y, w, h, q) {
  const slots = w / COLS_PER_SLOT
  if (slots < laneSlots(OTHER[id])) throw new Error(`${id} needs ${laneSlots(OTHER[id])} slots, ${w} columns give ${slots}`)
  return laneCanvas(title, q(`${STATE}?chain=${id}`, { root: CHAIN_PIVOT }), OTHER[id], x, y, w, h, slots)
}
const CHAIN_NAMES = JSON.stringify({ daily_readiness: '每日', intraday_guard: '盤中', weekly_research: '每週', monthly_artifact: '每月' })
/** Stage names (every chain) for responses that carry only stage_id. */
const NAMES = JSON.stringify(Object.fromEntries([...dag.catalog, ...Object.values(OTHER).flatMap((chain) => Object.entries(chain.stages).map(([id, stage]) => ({ id, label: stage.label })))]
  .map((stage) => [stage.id, stage.label])))
/** Every daily stage in Canvas order: phase by phase, the lane left to right, then the side row. A parent the Canvas shows
 * as its sub-stages (FinLab, Pipeline) sits just before them; a stage the Canvas leaves out (ML Predict) follows the catalog
 * stage before it, after that stage's sub-stages. The status history uses this order. */
const CANVAS_ORDER = (() => {
  const places = new Map()
  dag.phases.forEach((phase, index) => [...phase.main, ...phase.side].forEach((id) => places.set(id, { pos: places.size, phase: index })))
  const children = (id) => [...places.entries()].filter(([child]) => dag.stages[child]?.parent === id).map(([, place]) => place)
  for (const { id } of dag.catalog) {
    const subs = children(id)
    if (!places.has(id) && subs.length) places.set(id, { pos: Math.min(...subs.map((place) => place.pos)) - 0.5, phase: subs[0].phase })
  }
  let previous = null
  for (const { id } of dag.catalog) {
    if (!places.has(id) && previous) {
      const after = [places.get(previous), ...children(previous)].reduce((last, place) => (place.pos > last.pos ? place : last))
      places.set(id, { pos: after.pos + 0.01, phase: after.phase })
    }
    previous = id
  }
  const label = (id) => dag.stages[id]?.label ?? dag.catalog.find((stage) => stage.id === id)?.label ?? id
  return [...places.entries()].sort(([, a], [, b]) => a.pos - b.pos).map(([id, { phase }]) => ({ id, phase, name: `${'①②③④'[phase]} ${label(id)}` }))
})()
const ORDER = JSON.stringify(Object.fromEntries(CANVAS_ORDER.map(({ id }, position) => [id, position])))
/** Stage name with its phase number, so the grid rows read as four groups in the Canvas's order. */
const PHASED_NAMES = JSON.stringify(Object.fromEntries(CANVAS_ORDER.map(({ id, name }) => [id, name])))
const CLOCK = 'time:MM/DD HH:mm'
/** Rows in Canvas order, oldest first within a stage: the state panels draw one row per stage in order of first appearance. */
const byChainOrder = (rows, time) => `$sort(${rows}, function($a, $b) {(
  $pa := $lookup(${ORDER}, $a.stage_id); $pb := $lookup(${ORDER}, $b.stage_id);
  $pa > $pb or ($pa = $pb and $a.${time} > $b.${time})
)})`
/** Clock time in Taiwan for detail text. */
const HM = `$hm := function($t) { $t ? $fromMillis($toMillis($t), '[M01]/[D01] [H01]:[m01]', '+0800') : '' }`

/** Readiness checks the Worker labels in English, and the stage that writes each one. */
const CHECK_NAMES = JSON.stringify({ price_freshness: '價格資料', chip_freshness: '籌碼資料', technical_indicator_freshness: '技術指標',
  market_dashboard_materialization: '首頁行情資料' })
const CHECK_WRITERS = JSON.stringify({ price_freshness: dag.stages['market-close-refresh'].label, chip_freshness: dag.stages.update.label,
  technical_indicator_freshness: dag.stages['indicator-queue'].label })
/** Minutes as one short word that fits a phone column: 42 分, 7.3 h, 1.6 天. */
const SHORT_DURATION = (field) => `(${field} != null ? (${field} < 60 ? $string($round(${field})) & ' 分' : ${field} < 1440 ? $string($round(${field} / 60, 1)) & ' h'
  : $string($round(${field} / 1440, 1)) & ' 天') : '—')`
/** A row's reason as the panels show it: the Worker's short zh-TW `error_brief` (errorBrief.ts), or for a Worker that does not
 * send it the generic reason; never the raw error (tracebacks and codes). `brief` names the field, `raw` the error it summarises. */
/** 要處理's short columns hold their header with its sort arrow (the first and last column have 12 px more: 鏈 and 次數 at
 * 52 px were cut at 1440) and their longest value; 階段 takes the rest. */
const TODO_WIDTHS = { 鏈: 64, 狀況: 66, 持續: 70, 次數: 78 }
/** 要處理: rows a 8-unit-high table shows without scrolling (header + 5 rows of 36 px, about 243 px inside), and its order, worst first. */
const TODO_ROWS = 5
const TODO_RANK = JSON.stringify({ failed: 1, missed: 2, stuck: 3, blocked: 4, overdue: 5 })
const BRIEF = (brief = 'error_brief', raw = 'error') => `(${brief} ? ${brief} : ${raw} ? '${ERROR_FALLBACK}' : '沒有錯誤訊息')`
/** Readiness reasons in words: the Worker's root-cause codes (dataQualityMonitor buildMarketDashboardMaterializationCheck and
 * the sources' own root causes); any other code reads 狀態異常, a sentence keeps its words with "lag Nd" as 落後 N 天. */
const READINESS_CODES = JSON.stringify({ fresh: '正常', ok: '正常', ready: '正常', freshness_lag: '資料落後', stale_materialization: '資料過期',
  not_materialized: '尚未寫入', formal_shadow_fetch_failed: '正式抓取失敗' })
const READINESS_DETAIL = (field) => `(${field} ? ($c := $lookup(${READINESS_CODES}, ${field}); $c ? $c
  : $contains(${field}, /^[A-Za-z0-9_:-]+$/) ? '狀態異常' : $replace(${field}, /\\s*\\/?\\s*lag (\\d+)d/, '｜落後 $1 天')) : '—')`
/** A home-page row's count ("1,906 rows") in words. */
const READINESS_ROWS = (field) => `(${field} ? $replace(${field}, ' rows', ' 列') : '—')`
/** A freshness check in words, from its fields (its summary is an English sentence). */
const CHECK_DETAIL = `(latest_date ? '最新 ' & latest_date & '｜落後 ' & (lag_days != null ? $string(lag_days) : '—') & ' 天'
  & (rows_on_latest != null ? '｜' & $string(rows_on_latest) & ' 列' : '') : $lookup(${JSON.stringify(Object.fromEntries(Object.entries(READINESS_VOCAB).map(([k, [w]]) => [k, w])))}, status))`
/** One readiness card per home-page source (MATERIALIZATION_SOURCES in the Worker) and per freshness check. */
const READINESS_SLOTS = (readFileSync(join(here, '../../../worker/src/monitoring/dataReadiness.ts'), 'utf8')
  .split('export const MATERIALIZATION_SOURCES')[1].split('\n];')[0].match(/\{ key: '/g).length) + Object.keys(JSON.parse(CHECK_WRITERS)).length
/** Worst first: 缺漏, 遲到, 未到, 正常 (both vocabularies, see READINESS_VOCAB). */
const READINESS_RANK = JSON.stringify({ fail: 0, blocked: 0, warn: 1, waiting: 1, pending: 2, running: 2, ready: 3, ok: 3 })
/** The home-page items (rows) and the freshness checks as one table; `only` filters both (phone page). */
function readinessTable(q, title, x, y, w, h, { only = 'true', empty, hide = [] } = {}) {
  const columns = [N('rank', '序'), S('label', '項目'), S('status', '狀態'), S('latest', '最新日期'), S('note', '說明')]
  return table(title, [
    q(READINESS, { root: `rows[${only}].{ 'rank': $lookup(${READINESS_RANK}, status), 'label': label, 'status': status, 'latest': latestDate,
      'note': ${READINESS_ROWS('value')} & '；' & ${READINESS_DETAIL('detail')} }`, columns, refId: 'A' }),
    q(READINESS, { root: `checks[${only}].{ 'rank': $lookup(${READINESS_RANK}, status), 'label': ($n := $lookup(${CHECK_NAMES}, id); $n ? $n : label),
      'status': status, 'latest': latest_date, 'note': ${CHECK_DETAIL} }`, columns, refId: 'B' }),
  ], x, y, w, h, { status: ['狀態'], vocabulary: READINESS_VOCAB, sort: '序', hide: ['序', ...hide], wd: { 狀態: 64, 最新日期: 100 }, empty })
}

const ACTIVE_ROWS = 'rows[active = true and optional = false and sub_stage != true and eta_margin_min != null]'
function marginTable(q, title, x, y, w, h, { hide = [] } = {}) {
  return table(title, q(STATE, { root: `$sort(${ACTIVE_ROWS}, function($a, $b) { $a.eta_margin_min > $b.eta_margin_min }).{ 'stage': label, 'eta': eta,
    'due': expected_by, 'margin': eta_margin_min }`, columns: [S('stage', '階段'), T('eta', '預估完成'), T('due', '截止'), N('margin', '餘裕')] }), x, y, w, h,
  { num: { 餘裕: [[C.bad, null], [C.warn, 0], [C.ok, 15]] }, unit: { 餘裕: 'm', 預估完成: CLOCK, 截止: CLOCK }, wd: { 預估完成: 92, 截止: 92, 餘裕: 64 }, hide,
    empty: '沒有可估算的未完成必要階段', desc: '預估＝這條鏈的起點＋該階段近 14 天的典型完成時間（至少 3 天樣本），不早於現在；樣本不足的階段不列。負值＝預估會超過截止。' })
}

/** A KPI value '<ok|warn>|<text>': the text, white when ok and amber otherwise. */
const FLAG_MAPPINGS = [['ok', C.txt], ['warn', C.warn]].map(([key, color], index) => ({ type: 'regex', options: { pattern: `^${key}\\|(.*)$`, result: { text: '$1', color, index } } }))
const calc = (options) => ({ id: 'calculateField', options })

/** Page ①: should anything be done right now. One Canvas holds the chain, each stage's timing (tooltip) and the data
 * readiness of the three datasets the evening writes; under it only what needs action and the dataset tiles. */
function today(q) {
  fitColumn('要處理', '鏈', ['每日', '盤中', '每週', '每月'], TODO_WIDTHS.鏈, true)
  fitColumn('要處理', '狀況', ['失敗', '漏跑', '卡住', '逾時', '被擋住'], TODO_WIDTHS.狀況)
  fitColumn('要處理', '持續', ['59 分', '23.9 h', '99.9 天'], TODO_WIDTHS.持續)
  fitColumn('要處理', '次數', ['14'], TODO_WIDTHS.次數, true)
  const state = (root, columns, refId) => q(STATE, { root, columns, refId })
  const active = 'current[active = true]'
  const counts = [state(`${active}.{ 'done': required_done }`, [N('done', '完成')], 'A'),
    state(`${active}.{ 'total': required_total, 'all': required_total }`, [N('total', 'total'), N('all', 'all')], 'B')]
  const progress = { type: 'gauge', title: '必要階段', description: '指針＝這一輪已完成的必要階段數，滿格＝必要階段總數；全部完成時轉綠。',
    gridPos: gp(0, 0, 4, 4), datasource: counts[0].datasource, targets: counts,
    transformations: [{ id: 'configFromData', options: { configRefId: 'B', mappings: [{ fieldName: 'total', handlerKey: 'max' }, { fieldName: 'all', handlerKey: 'threshold1' }] } }],
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', showThresholdMarkers: false, showThresholdLabels: false,
      sizing: 'auto', minVizWidth: 60, minVizHeight: 60, text: { titleSize: 12, valueSize: 20 } },
    fieldConfig: { defaults: { min: 0, decimals: 0, noValue: NO_SOURCE, color: { mode: 'thresholds' }, thresholds: th([C.run, null]) }, overrides: [] } }
  const strip = kpi('這一輪', [
    q(ALERTS, { root: `{ 'k': 1, 'bad': counts.failed + counts.stuck + counts.missed, 'overdue': counts.overdue + ($exists(counts.blocked) ? counts.blocked : 0) }`,
      columns: [KPI_KEY, N('bad', '失敗'), N('overdue', '逾時')], refId: 'A' }),
    state(`($now := $toMillis(generated_at); { 'k': 1, 'risk': $count(rows[active = true and display_status = 'at_risk']),
      'at': $max(rows[active = true and updated_at != null].$toMillis(updated_at)),
      'next': $min(rows[active = true and optional = false and sub_stage != true and $not(completed_at) and expected_by != null].(($toMillis(expected_by) - $now) / 60000)[$ >= 0]) })`,
    [KPI_KEY, N('risk', '趕不上'), N('at', '最新寫入'), N('next', '下一個截止')], 'B'),
    q(READINESS, { root: `($all := $append(rows, checks[id != 'market_dashboard_materialization']); $ok := $count($all[status in ['ready', 'ok']]);
      { 'k': 1, 'ready': ($ok = $count($all) ? 'ok|' : 'warn|') & $string($ok) & '／' & $string($count($all)) })`, columns: [KPI_KEY, S('ready', '資料就緒')], refId: 'C' }),
  ], 4, 0, 20, 4, [
    { name: '失敗', th: th([C.txt, null], [C.bad, 1]) }, { name: '逾時／趕不上／被擋住', th: th([C.txt, null], [C.warn, 1]) },
    { name: '最新寫入', unit: 'dateTimeFromNow' }, { name: '資料就緒', mappings: FLAG_MAPPINGS }, { name: '下一個截止', unit: 'm', th: th([C.warn, null], [C.txt, 15]) },
  ])
  strip.description = '失敗＝四條鏈的失敗＋卡住＋漏跑；逾時／趕不上／被擋住＝四條鏈逾時＋每日鏈預估會超過截止的站＋盤中監控過了 09:10 仍被擋住（被擋住不是逾時，在要處理清單裡分開列）；最新寫入＝每日鏈最後一次狀態回報；'
    + '資料就緒＝正常的資料集／全部；下一個截止＝還沒完成的必要階段裡，最近一個截止還有多久。'
  strip.transformations.push(calc({ mode: 'binary', binary: { left: '逾時', operator: '+', right: '趕不上' }, alias: '逾時／趕不上／被擋住' }),
    { id: 'organize', options: { excludeByName: { 逾時: true, 趕不上: true }, renameByName: {},
      indexByName: Object.fromEntries(['失敗', '逾時／趕不上／被擋住', '最新寫入', '資料就緒', '下一個截止'].map((name, i) => [name, i])) } })
  const items = `$sort($append(
    rows.{ 'rank': $lookup(${READINESS_RANK}, status), 'name': label, 'status': status, 'short': latestDate ? $replace($substring(latestDate, 5), '-', '/') : '—',
      'note': ${READINESS_ROWS('value')} & '｜' & ${READINESS_DETAIL('detail')}, 'source': '來源：' & source },
    checks[id != 'market_dashboard_materialization'].{ 'rank': $lookup(${READINESS_RANK}, status), 'name': $lookup(${CHECK_NAMES}, id), 'status': status,
      'short': lag_days ? '落後 ' & $string(lag_days) & ' 天' : latest_date ? $replace($substring(latest_date, 5), '-', '/') : '—',
      'note': ${CHECK_DETAIL}, 'source': '寫入：' & $lookup(${CHECK_WRITERS}, id) }
  ), function($a, $b) { $a.rank > $b.rank })`
  return [
    progress,
    strip,
    chainPanel(state, q),
    // Worst first (failed, missed, stuck, blocked, overdue; then the most failures in 14 days); past TODO_ROWS rows the
    // last row counts the rest, so the panel never scrolls inside.
    table('要處理', q(ALERTS, { root: `(${HM}; $rank := function($r) { ($k := $lookup(${TODO_RANK}, $r.kind); $k ? $k : 9) };
        $all := $sort(rows, function($a, $b) { $rank($a) = $rank($b) ? $a.failures_14d < $b.failures_14d : $rank($a) > $rank($b) });
        $n := $count($all); $out := ($n > ${TODO_ROWS} ? $all[[0..${TODO_ROWS - 2}]] : $all).{ 'chain': $lookup(${CHAIN_NAMES}, ${ROW_CHAIN}),
        'stage': $lookup(${NAMES}, stage_id), 'kind': ${ALERT_KIND()},
        'minutes': ${SHORT_DURATION('minutes')}, 'times': failures_14d, 'reason': ${BRIEF()},
        'when': $join(['業務日 ' & business_date, since ? '開始 ' & $hm(since), expected_by ? '截止 ' & $hm(expected_by), attempt ? '第 ' & $string(attempt) & ' 次'], '｜') };
        $n > ${TODO_ROWS} ? $append($out, [{ 'chain': '', 'stage': '另有 ' & $string($n - ${TODO_ROWS - 1}) & ' 筆', 'kind': '', 'minutes': '', 'reason': '', 'when': '' }]) : $out)`,
      columns: [S('chain', '鏈'), S('stage', '階段'), S('kind', '狀況'), S('minutes', '持續'), N('times', '次數'), S('reason', '錯誤'), S('when', '時間')] }),
      0, 20, 7, 8, { status: ['狀況'], num: { 次數: [[C.txt, null], [C.bad, 2]] }, wd: TODO_WIDTHS, mw: { 階段: 50 },
        hidden: ['錯誤', '時間'], details: { 階段: ['錯誤', '時間'] }, empty: '沒有',
        desc: '四條鏈裡失敗、逾時、卡住、漏跑的站，和過了 09:10 仍被擋住的盤中監控；全部正常時只顯示「沒有」。持續＝這個狀況已經多久；次數＝近 14 天第幾次失敗。點階段名稱看錯誤與起訖、截止、嘗試次數。' }),
    readinessCanvas('資料就緒', q(READINESS, { root: readinessPivot(items) }), READINESS_SLOTS, 7, 20, 17, 8, { cols: Math.ceil(READINESS_SLOTS / 2),
      desc: '每個資料集一格，有問題的排前面。格子下方＝狀態與最新資料日（或落後天數），顏色：正常＝綠、遲到＝琥珀、缺漏＝紅、未到＝灰；遲到與缺漏的格子另加同色外框。'
        + '滑鼠停在格子上看說明與來源。' }),
  ]
}
/** ①'s chain: state (A), the readiness dots (B) and the slow tags (C, slowPivot over the 14-day timeline), joined into
 * one row on their `one` key so a box's tooltip lines can read fields from both A and C. */
function chainPanel(state, q) {
  const panel = chainCanvas('流程鏈', [state(CHAIN_PIVOT, [], 'A'), q(READINESS, { root: DOTS_PIVOT, refId: 'B' }),
    q(TIMELINE, { root: slowPivot(Object.keys(dag.stages)), refId: 'C' })], dag, 0, 4, 24, 16, {
    desc: '由左到右＝先後，箭頭＝相依（完成後轉綠、執行中藍）；粗框＝必要階段，細框＝只看失敗的階段。框色與左上圓點＝狀態（✓ 完成、… 執行中、! 逾時、✕ 失敗；灰點 …＝排定的等待，例如等 14:20 盤後 dispatch，不算耗時）；每段標題旁＝必要階段完成數；'
      + '底色只標還沒完成的站：離截止 10–30 分＝灰藍，不到 10 分＝琥珀，超過截止＝深琥珀；準時完成的不上色（餘裕在 tooltip），逾時完成的維持深琥珀。Intraday check 整段盤中都在跑，只看狀態、不算餘裕。'
      + '方塊下方一行：完成＝耗時、執行中＝已經過、未開始＝餘裕；右側淡紫 +Xm＝比平常慢（今晚耗時超過近 14 天中位數 1.5 倍且多 5 分以上，timeline 少於兩個業務日時不顯示）。右上圓點＝這一站寫入的資料集是否就緒。'
      + '滑鼠停在方塊或圓點上看起訖、截止、預估、平常耗時、嘗試次數與錯誤。' })
  panel.transformations = [{ id: 'joinByField', options: { byField: 'one', mode: 'outer' } }]
  return panel
}
const HISTORIES = Object.entries(JSON.parse(CHAIN_NAMES)).map(([id, name]) => [id === 'daily_readiness' ? HISTORY : `${HISTORY}&chain=${id}`, name])
/** A history row of a watcher (intraday-check): the row's own `watcher`, else the stage id (Workers that do not send it). */
const WATCHER_ROW = `($type(watcher) = 'boolean' ? watcher : stage_id in ${WATCHERS})`
/** History results are the raw ChainStatus: blocked (the chain aborted there) counts as a failure. A watcher's blocked is
 * the amber 被擋住 (Wei 11/26): neither a failure nor a finished run, so it leaves the success rate alone. */
const FAILED = `(result = 'error' or (result = 'blocked' and $not(${WATCHER_ROW})))`
const FINISHED = `(result in ['success', 'retry_success', 'error'] or (result = 'blocked' and $not(${WATCHER_ROW})))`
/** A history row's result as a STATUS key. */
const RESULT = `(result = 'blocked' and ${WATCHER_ROW} ? 'watcher_blocked' : result)`
/** One row per business date of a history response: time (Taiwan midnight) and `value` over that date's rows `$r`. */
const perDate = (value) => `$sort($distinct(rows.business_date)).($d := $; $r := $$.rows[business_date = $d]; { 'time': $r[0].time, 'v': ${value} })`
/** Only a final failure is red and in progress blue (statuses); two classes take categorical slots, and the two smallest
 * (未收尾, 設計性重試) fold into 其他 so a chart has at most five colours. */
const FAILURE_CLASS_SERIES = [['最終失敗', `$count($r[class = 'final_failure'])`, C.bad], ['上游擋下', `$count($r[class = 'upstream_blocked'])`, COOL.cat[2]],
  ['重試後成功', `$count($r[class = 'recovered'])`, COOL.cat[0]], ['進行中', `$count($r[class = 'in_progress'])`, C.run],
  ['其他', `$count($r[class in ['orphan_running', 'unsettled_triggered', 'designed_retry']])`, COOL.other]]
const FAILURE_CLASS_NOTE = '依 (job, 日) 歸成一類：最終失敗、上游擋下、重試後成功、進行中；其他＝未收尾＋設計性重試。'

/** Page ②: what keeps breaking or slowing down over the last 14 business days. */
function health(q) {
  const [daily, intraday] = HISTORIES
  const rate = ([path, name], x) => spark(`${name}鏈成功率`, q(path, { root: perDate(`($f := $r[${FINISHED}]; $count($f) ? $count($f[$not(${FAILED})]) / $count($f) : null)`),
    columns: [T('time', 'time'), N('v', '成功率')] }), x, 0, 5, 4, { calc: 'mean', unit: 'percentunit', dec: 1, th: th([C.bad, null], [C.warn, 0.9], [C.txt, 0.97]),
    desc: '每個業務日「跑完的站裡沒失敗的比例」的 14 天平均；折線＝每天的比例。' })
  // Sum of each stage's running → finished minutes per business date (the timeline's transitions; parallel stages add up).
  const minutes = `$sum($distinct($r.stage_id).($s := $; $t := $r[stage_id = $s];
    $a := $min($t[to_status = 'running'].$toMillis(transition_at)); $b := $max($t[to_status in ['success', 'error', 'skipped', 'blocked']].$toMillis(transition_at));
    $a and $b and $b > $a ? ($b - $a) / 60000 : 0))`
  return [
    rate(daily, 0),
    rate(intraday, 5),
    spark('每日鏈失敗站次', q(HISTORY, { root: perDate(`$count($r[${FAILED}])`), columns: [T('time', 'time'), N('v', '失敗站次')] }), 10, 0, 5, 4,
      { calc: 'sum', th: th([C.txt, null], [C.bad, 1]), desc: '近 14 個業務日失敗或中止的站次合計；折線＝每天幾站。' }),
    kpi('重複失敗（失敗 2 次以上的階段數）', HISTORIES.map(([path, name], i) => q(path, { root: `{ 'k': 1, 'n': $count(repeat_failures[failures >= 2]) }`,
      columns: [KPI_KEY, N('n', name)], refId: 'ABCD'[i] })), 15, 0, 9, 4, HISTORIES.map(([, name]) => ({ name, th: th([C.txt, null], [C.bad, 1]) }))),
    { type: 'timeseries', title: '每日各站耗時加總', gridPos: gp(0, 4, 16, 4),
      description: '每個業務日、每日鏈各站「開始執行 → 結束」的分鐘數加總（並行的站會疊加），看整條鏈有沒有越跑越久。',
      targets: [q(TIMELINE, { root: `$sort($distinct(rows.business_date)).($d := $; $r := $$.rows[business_date = $d];
        { 'time': $fromMillis($toMillis($d & 'T00:00:00+08:00')), 'minutes': ${minutes} })`, columns: [T('time', 'time'), N('minutes', '耗時')] })],
      options: { legend: { showLegend: false }, tooltip: { mode: 'single' } },
      fieldConfig: { defaults: { unit: 'm', decimals: 0, min: 0, noValue: NO_SOURCE, color: { mode: 'fixed', fixedColor: COOL.cat[0] },
        custom: { drawStyle: 'bars', barAlignment: 0, fillOpacity: 70, lineWidth: 0, axisPlacement: 'right' } }, overrides: [] } },
    states('status-history', '每日鏈近 14 天', q(HISTORY, {
      root: `${byChainOrder('rows', 'time')}.{ 'time': time, 'stage': ($n := $lookup(${PHASED_NAMES}, stage_id); $n ? $n : label), 'result': ${RESULT} }`,
      columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')] }), 'stage', 0, 8, 16, 14,
    { opts: { colWidth: 0.92 }, desc: '一格＝一站一個業務日的最終結果；列順序＝今天頁的流程鏈（①–④＝phase）。' }),
    // One query per chain, rows stacked: daily and intraday cover 14 days, weekly its last 5 periods, monthly 3.
    table('重複失敗', HISTORIES.map(([path, name], i) =>
      q(path, { root: `repeat_failures[failures >= 2].{ 'chain': '${name}', 'stage': label, 'failures': failures, 'dates': '失敗日 ' & dates, 'reason': ${BRIEF('last_error_brief', 'last_error')} }`,
        columns: [S('chain', '鏈'), S('stage', '階段'), N('failures', '次數'), S('dates', '失敗日'), S('reason', '最後錯誤')], refId: 'ABCD'[i] })),
    16, 4, 8, 8, { num: { 次數: [[C.txt, null], [C.bad, 2]] }, wd: { 鏈: 48, 次數: 64 }, sort: '次數', desc_sort: true, hidden: ['失敗日', '最後錯誤'],
      details: { 階段: ['最後錯誤', '失敗日'] }, empty: '沒有',
      desc: '失敗 2 次以上的階段（每日／盤中＝14 天，每週＝5 週，每月＝3 個月）。點階段名稱看失敗日與最後一次的錯誤。' }),
    stackedBars('14 天失敗分類（scheduler ticket）', [q(FAILURE_CLASSES, {
      root: `$sort($distinct(rows.business_date)).($d := $; $r := $$.rows[business_date = $d]; $merge([{ 'date': $replace($substring($d, 5), '-', '/') },
        ${FAILURE_CLASS_SERIES.map(([name, value]) => `{ '${name}': ${value} }`).join(', ')}]))`,
      columns: [S('date', 'date'), ...FAILURE_CLASS_SERIES.map(([name]) => N(name, name))] })], 'date', 16, 12, 8, 10,
    FAILURE_CLASS_SERIES.map(([name, , color]) => [name, color]),
    { desc: `每個業務日非成功的 scheduler ticket，${FAILURE_CLASS_NOTE}` }),
    lanePanel('每週研究', 'weekly_research', 0, 22, 16, 6, q),
    lanePanel('每月 artifact', 'monthly_artifact', 16, 22, 8, 6, q),
    lanePanel('盤中守門與收盤帳務', 'intraday_guard', 0, 28, 11, 8, q),
    // One row per intraday stage (8): h 8 gives each row room for its name.
    states('status-history', '盤中鏈近 14 天', q(intraday[0], {
      root: `$sort(rows, function($a, $b) { $a.position > $b.position or ($a.position = $b.position and $a.time > $b.time) }).{ 'time': time, 'stage': label, 'result': ${RESULT} }`,
      columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')] }), 'stage', 11, 28, 13, 8, { opts: { colWidth: 0.92 },
      desc: '一格＝一站一個業務日的最終結果。' }),
  ]
}

const GCP_PROJECT = 'gen-lang-client-0602998820'
const at = (panel, x, y, w, h, extra = {}) => ({ ...panel, gridPos: gp(x, y, w, h), ...extra })
/** One Cloud Monitoring series query, grouped by one label (or not at all). */
const gcpSeries = (refId, filters, groupBy, aligner, period, alias, reducer = 'REDUCE_SUM') => ({ refId, datasource: GCP_DS, queryType: 'timeSeriesList',
  timeSeriesList: { projectName: GCP_PROJECT, filters, crossSeriesReducer: reducer, perSeriesAligner: aligner, alignmentPeriod: period, groupBys: groupBy ? [groupBy] : [] }, aliasBy: alias })
/** `o.dec`: null leaves decimals to Grafana (a fraction in percentunit with 0 decimals only gets ticks at 0% and 100%).
 * `o.placement`: legend position (default: a table on the right, a list at the bottom). */
const gcpTimeseries = (title, targets, o = {}) => ({ type: 'timeseries', title, description: o.desc ?? '', datasource: GCP_DS, targets, timeFrom: o.timeFrom,
  options: { legend: { showLegend: true, displayMode: o.legend ?? 'table', placement: o.placement ?? (o.legend === 'list' ? 'bottom' : 'right'), calcs: o.calcs ?? ['max'] },
    tooltip: { mode: 'multi' } },
  fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec === undefined ? 0 : o.dec, min: 0, custom: { ...(o.points
    ? { drawStyle: 'points', pointSize: 7, fillOpacity: 0, lineWidth: 0 }
    : o.bars ? { drawStyle: 'bars', barAlignment: 0, fillOpacity: 85, lineWidth: 0, stacking: { mode: 'normal' } }
      : { drawStyle: 'line', lineInterpolation: 'stepAfter', fillOpacity: 20, stacking: { mode: o.stack === false ? 'none' : 'normal' } }),
  ...(o.softMax != null ? { axisSoftMax: o.softMax } : {}) } }, overrides: [] } })
const INSTANCES = ['resource.type', '=', 'cloud_run_revision', 'AND', 'metric.type', '=', 'run.googleapis.com/container/instance_count', 'AND', 'metric.label.state', '=', 'active']
const RUNNING = ['resource.type', '=', 'cloud_run_job', 'AND', 'metric.type', '=', 'run.googleapis.com/job/running_executions']

/** Cloud Run over Google Cloud Monitoring (already live; the fixture build reads it too), unplaced. */
function gcpPanels() {
  const source = json('../dashboards/gcp-cloud-run-scheduler.json').panels
  const pick = (title) => { const { id, gridPos, ...panel } = source.find((p) => p.title === title); return structuredClone(panel) }
  const outcome = (title, alias) => { const target = structuredClone(pick(title).targets[0]); target.timeSeriesList.alignmentPeriod = '+86400s'; return { ...target, aliasBy: alias } }
  return {
    daily: { type: 'timeseries', title: 'Cloud Run Job 每 24 小時成功／失敗', datasource: source[0].datasource,
      targets: [{ ...outcome('Cloud Run Job 成功次數（所選時間）', '成功'), refId: 'A' }, { ...outcome('Cloud Run Job 失敗次數（所選時間）', '失敗'), refId: 'B' }],
      options: { legend: { showLegend: false }, tooltip: { mode: 'multi' } },
      fieldConfig: { defaults: { unit: 'none', decimals: 0, min: 0, custom: { drawStyle: 'bars', barAlignment: 0, fillOpacity: 85, lineWidth: 0, stacking: { mode: 'normal' } } },
        overrides: [['A', C.ok], ['B', C.bad]].map(([refId, color]) => ({ matcher: { id: 'byFrameRefID', options: refId }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } },
    requests: gcpTimeseries('Cloud Run 服務請求（每小時）', [gcpSeries('A', ['resource.type', '=', 'cloud_run_revision', 'AND', 'metric.type', '=', 'run.googleapis.com/request_count'],
      'resource.label.service_name', 'ALIGN_SUM', '+3600s', '{{resource.label.service_name}}')], { bars: true, legend: 'list', calcs: [], desc: '每個服務每小時的請求數（所有回應類別）。' }),
    latency: { ...pick('Cloud Run 服務延遲 p95'), title: 'Cloud Run 服務延遲 p95',
      options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } } },
    instances: gcpTimeseries('Cloud Run 服務執行個體（每小時最高）', [gcpSeries('A', INSTANCES, 'resource.label.service_name', 'ALIGN_MAX', '+3600s', '{{resource.label.service_name}}')],
      { legend: 'list', calcs: [] }),
    cpu: gcpTimeseries('Cloud Run 服務 CPU 使用率（每小時 p95）', [gcpSeries('A', ['resource.type', '=', 'cloud_run_revision', 'AND', 'metric.type', '=',
      'run.googleapis.com/container/cpu/utilizations'], 'resource.label.service_name', 'ALIGN_PERCENTILE_95', '+3600s', '{{resource.label.service_name}}', 'REDUCE_MAX')],
    { unit: 'percentunit', dec: null, softMax: 0.25, legend: 'list', calcs: [], stack: false, desc: '每個服務各執行個體 CPU 使用率分佈的 p95，取所有執行個體的最高。縱軸至少到 25%，超過時自動放大。' }),
    instancesNow: (x, y, w, h) => spark('Cloud Run 執行個體', gcpSeries('A', INSTANCES, null, 'ALIGN_MAX', '+300s', '執行個體'), x, y, w, h,
      { empty: '0', desc: '所有 Cloud Run 服務目前的執行個體數（每 5 分鐘最高）；折線＝所選時間內的變化。' }),
    // running_executions is a gauge sampled once a minute, so its 24-hour sum is the minutes an execution was running.
    jobMinutes: gcpTimeseries('訓練與研究 Job 每 24 小時執行時間', [gcpSeries('A', RUNNING, 'resource.label.job_name', 'ALIGN_SUM', '+86400s', '{{resource.label.job_name}}')],
      { points: true, unit: 'm', legend: 'list', placement: 'right', calcs: [],
        desc: 'Cloud Run Job 每 24 小時執行中的分鐘數（每分鐘取樣的執行中 execution 數加總；同時兩個 execution 算兩倍），一點＝一個 job 一天。Cloud Monitoring 以查詢結束時間對齊，不是日曆日。' }),
  }
}

/** GCP billing: the detailed (resource-level) export in BigQuery, amounts in the billing account's currency (TWD). */
const BILLING = '`gen-lang-client-0602998820.billing_export.gcp_billing_export_resource_v1_018BA5_A4B827_5694C8`'
/** Credits are negative amounts: net = cost + credits. */
const CREDITS = 'IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)'
/** Every query reads only the partitions the time range can need: partitions are by ingestion day (UTC), so a partition
 * never holds usage from after its own day (a late export can land older usage in a later one). The partition filter
 * therefore only bounds the start, a day before the range (Taiwan midnight is 16:00 UTC the day before), and the usage
 * filter makes the exact cut. */
const BILLING_RANGE = '_PARTITIONTIME >= TIMESTAMP_SUB($__timeFrom(), INTERVAL 1 DAY) AND $__timeFilter(usage_start_time)'
const BILLING_DAY = `TIMESTAMP(DATE(usage_start_time, 'Asia/Taipei'), 'Asia/Taipei')`
const TODAY_TW = `CURRENT_DATE('Asia/Taipei')`
const TWD = 'prefix:NT$'
const MONTH = 'now/M'
const BILLING_NOTE = 'BigQuery 帳單明細匯出（新台幣，已扣抵免）；資料晚幾小時到一兩天才齊，最近一天偏低。不含 Cloudflare、Modal。'

/** Cost panels over the billing export; the fixture build reads `mock` (mock.mjs) in the same columns. Tables (format 1)
 * in both builds, so the panels and their transformations are the same. */
/** A service keeps its colour whatever its rank; a service not listed here takes the 其他 grey (its name is still in the legend). */
const SERVICE_COLORS = [['Cloud Run', COOL.cat[0]], ['Cloud Storage', COOL.cat[1]], ['Artifact Registry', COOL.cat[2]], ['Cloud Build', COOL.cat[3]]]
function costPanels(q, mode) {
  const billing = (rawSql, mock, columns) => (mode === 'live'
    ? { refId: 'A', datasource: BIGQUERY_DS, editorMode: 'code', rawQuery: true, format: 1, project: GCP_PROJECT, rawSql: rawSql.replace(/\s+/g, ' ').trim() }
    : q(mock, { root: 'rows', columns }))
  const perDay = (mock) => billing(`SELECT ${BILLING_DAY} AS time, SUM(cost) + SUM(${CREDITS}) AS net FROM ${BILLING} WHERE ${BILLING_RANGE} GROUP BY time ORDER BY time`,
    mock, [T('time', 'time'), N('net', 'net')])
  return {
    month: spark('本月累計', perDay('mock:billing-month-daily'), 0, 0, 5, 4, { calc: 'sum', unit: TWD, timeFrom: MONTH, desc: `本月 1 日至今的 GCP 淨額；折線＝每天。${BILLING_NOTE}` }),
    forecast: spark('月底預估', billing(`SELECT (SUM(cost) + SUM(${CREDITS})) / EXTRACT(DAY FROM ${TODAY_TW}) * EXTRACT(DAY FROM LAST_DAY(${TODAY_TW})) AS forecast
      FROM ${BILLING} WHERE ${BILLING_RANGE}`, 'mock:billing-forecast', [N('forecast', 'forecast')]), 5, 0, 5, 4,
    { line: false, unit: TWD, timeFrom: MONTH, desc: `本月累計 ÷ 今天是本月第幾天 × 本月天數（最近一天帳單不齊，會略偏低）。${BILLING_NOTE}` }),
    latest: spark('最近一天', perDay('mock:billing-recent-daily'), 10, 0, 5, 4, { unit: TWD, desc: `帳單裡最新一天的淨額；折線＝所選時間每天。${BILLING_NOTE}` }),
    // The four largest services by name, the rest as 其他 (at most five colours in one chart).
    byServiceDonut: Object.assign(donut('本月成本（依服務）', mode === 'live'
      ? billing(`WITH s AS (SELECT service.description AS svc, SUM(cost) + SUM(${CREDITS}) AS net FROM ${BILLING} WHERE ${BILLING_RANGE} GROUP BY svc HAVING net > 0),
        r AS (SELECT IF(ROW_NUMBER() OVER (ORDER BY net DESC) <= 4, svc, '其他') AS label, net, ROW_NUMBER() OVER (ORDER BY net DESC) AS rk FROM s)
        SELECT label AS svc, SUM(net) AS net FROM r GROUP BY label ORDER BY MIN(rk)`)
      : q('mock:billing-month-by-service', { root: `($r := rows; $append($r[[0..3]], $count($r) > 4 ? [{ 'svc': '其他', 'net': $sum($r[[4..999]].net) }] : []))`,
        columns: [S('svc', 'svc'), N('net', 'net')] }), 0, 10, 8, 8,
    { byRow: ['svc', 'net'], unit: TWD, colors: [...SERVICE_COLORS, ['其他', COOL.other]], fallback: COOL.other,
      desc: `本月 1 日至今各服務的 GCP 淨額占比：前四大服務，其餘併成「其他」。${BILLING_NOTE}` }), { timeFrom: MONTH, hideTimeOverride: true, gridPos: gp(8, 9, 7, 8) }),
    // Day of month on x (a trend panel), so the projection can run past today to the month's last day.
    cumulative: { type: 'trend', title: '本月累計成本', gridPos: gp(15, 9, 9, 8), timeFrom: MONTH, hideTimeOverride: true,
      description: `實線＝本月每天的累計淨額，虛線＝照目前日均推到月底，紅色虛線＝每月預算 NT$${MONTH_BUDGET_TWD.toLocaleString('en-US')}（示範值）。${BILLING_NOTE}`,
      targets: [billing(`WITH d AS (SELECT EXTRACT(DAY FROM DATE(usage_start_time, 'Asia/Taipei')) AS day, SUM(cost) + SUM(${CREDITS}) AS net FROM ${BILLING}
        WHERE ${BILLING_RANGE} GROUP BY day), c AS (SELECT day, SUM(net) OVER (ORDER BY day) AS actual FROM d), k AS (SELECT MAX(day) AS last, MAX(actual) AS mtd FROM c)
        SELECT g AS day, c.actual, IF(g >= k.last, k.mtd / k.last * g, NULL) AS forecast FROM k, UNNEST(GENERATE_ARRAY(1, EXTRACT(DAY FROM LAST_DAY(${TODAY_TW})))) AS g
        LEFT JOIN c ON c.day = g ORDER BY day`, 'mock:billing-month-cumulative', [N('day', 'day'), N('actual', '實際累計'), N('forecast', '月底預估')])],
      options: { xField: 'day', legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } },
      fieldConfig: { defaults: { unit: TWD, decimals: 0, min: 0, noValue: NO_SOURCE, color: { mode: 'fixed', fixedColor: COOL.cat[0] },
        thresholds: th(['transparent', null], [C.bad, MONTH_BUDGET_TWD]),
        custom: { drawStyle: 'line', lineWidth: 2, fillOpacity: 12, showPoints: 'never', spanNulls: false, thresholdsStyle: { mode: 'dashed' } } },
      // The amount axis reaches past the budget so its line is always drawn. On both amount fields (one shared axis; a setting on
      // only one gives it an axis of its own), not in the defaults (the day axis would take it too).
      overrides: [{ matcher: { id: 'byRegexp', options: '^(實際累計|月底預估)$' }, properties: [{ id: 'custom.axisSoftMax', value: MONTH_BUDGET_TWD * 1.1 }] },{ matcher: { id: 'byName', options: '月底預估' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: COOL.cat[2] } },
        { id: 'custom.lineStyle', value: { fill: 'dash', dash: [6, 4] } }, { id: 'custom.fillOpacity', value: 0 }] },
      { matcher: { id: 'byName', options: 'day' }, properties: [{ id: 'unit', value: 'none' }, { id: 'custom.axisLabel', value: '本月第幾天' }] }] } },
    byService: { type: 'timeseries', title: '每日成本（依服務堆疊）', description: BILLING_NOTE, gridPos: gp(0, 4, 14, 9),
      targets: [billing(`SELECT ${BILLING_DAY} AS time, service.description AS svc, SUM(cost) + SUM(${CREDITS}) AS net FROM ${BILLING} WHERE ${BILLING_RANGE}
        GROUP BY time, svc ORDER BY time`, 'mock:billing-by-service', [T('time', 'time'), S('svc', 'svc'), N('net', 'net')])],
      transformations: [{ id: 'partitionByValues', options: { fields: ['svc'], keepFields: false, naming: { asLabels: true } } }],
      options: { legend: { showLegend: true, displayMode: 'table', placement: 'right', calcs: ['sum', 'mean'] }, tooltip: { mode: 'multi', sort: 'desc' } },
      fieldConfig: { defaults: { displayName: '${__field.labels.svc}', unit: TWD, decimals: 0, noValue: NO_SOURCE, color: { mode: 'palette-classic' },
        custom: { drawStyle: 'bars', barAlignment: 0, fillOpacity: 85, lineWidth: 0, stacking: { mode: 'normal' } } }, overrides: [] } },
  }
}

/** Page ③: what the system runs on and what it costs (Google Cloud billing, D1, Cloud Run). */
function resources(q, mode) {
  const gcp = gcpPanels()
  const cost = costPanels(q, mode)
  return [
    cost.month, cost.forecast, cost.latest,
    kpi('D1 最滿的庫', [q(CAPACITY, { root: `($m := $max(rows.utilization_pct); { 'db': rows[utilization_pct = $m][0].binding_name, 'pct': $m })`,
      columns: [S('db', '庫'), N('pct', '使用率')] })], 15, 0, 4, 4,
      [{ name: '庫' }, { name: '使用率', unit: 'percent', dec: 1, th: th([C.txt, null], [C.warn, 80], [C.bad, 90]) }]),
    gcp.instancesNow(19, 0, 5, 4),
    cost.byService,
    lcd('D1 各資料庫用量', q(CAPACITY, { root: `$sort(rows, function($a, $b) { $a.utilization_pct < $b.utilization_pct }).{ 'db': binding_name, 'pct': utilization_pct }`,
      columns: [S('db', 'db'), N('pct', 'pct')] }), 'db', 'pct', 14, 4, 10, 9,
    { dec: 1, desc: '單庫上限 10 GB；80% 注意、90% 硬門檻。成長速度與到門檻天數在資料庫容量快照裡（/v1/capacity）。' }),
    { type: 'timeseries', title: 'D1 讀取／寫入列數（每小時）', gridPos: gp(0, 13, 14, 8),
      description: '來源規劃：Cloudflare GraphQL d1AnalyticsAdaptiveGroups（資料源 sv-cloudflare-api，token 未設，上線前不放）。',
      targets: [q('plan:cloudflare-d1-rows', { root: 'rows', columns: [T('time', 'time'), N('reads', '讀取列'), N('writes', '寫入列')] })],
      options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } },
      fieldConfig: { defaults: { unit: 'short', decimals: 0, min: 0, custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 15, lineWidth: 1 } },
        overrides: [{ matcher: { id: 'byName', options: '寫入列' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }, { id: 'color', value: { mode: 'fixed', fixedColor: COOL.cat[2] } }] },
          { matcher: { id: 'byName', options: '讀取列' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: COOL.cat[0] } }] }] } },
    lcd('Cloudflare 免費額度', q('plan:cloudflare-quota', { root: 'rows', columns: [S('product', 'product'), N('pct', 'pct')] }), 'product', 'pct', 14, 13, 10, 8,
      { desc: '本月用量 ÷ 方案含量。來源規劃：Cloudflare GraphQL＋Billing（資料源 sv-cloudflare-api，token 未設，上線前不放）。' }),
    at(gcp.instances, 0, 21, 12, 7),
    at(gcp.cpu, 12, 21, 12, 7),
    at(gcp.requests, 0, 28, 9, 7),
    at(gcp.latency, 9, 28, 8, 7),
    at(gcp.daily, 17, 28, 7, 7),
  ]
}

/** OPB arms in one categorical set (not status colours): four arms in colour, the two conservative arms as 其他 (one grey,
 * named in the legend and tooltip); an inert day (risk limits left one effective arm) is the dark 略過 grey. */
const ARM_COLORS = { base: COOL.cat[0], diversified_alpha: COOL.cat[1], diversified_all_eligible: COOL.cat[2], liquidity_diversified: COOL.cat[3],
  conservative_diversified: COOL.other, high_score_conservative: COOL.other, arm_inert: C.skip }
const ARM_MAPPINGS = [{ type: 'value', options: Object.fromEntries(Object.entries(ARM_COLORS).map(([arm, color], index) =>
  [arm, { text: arm === 'arm_inert' ? '被風控壓成一組' : arm, color, index }])) }]
/** A Taiwan date as the start of that day, as a millisecond `Z` stamp: Infinity's JSONata reads any other stamp shape
 * (an offset such as +08:00 included) as the date's UTC midnight, 08:00 in Taiwan. */
const DAY_TIME = (field) => `$fromMillis($toMillis(${field} & 'T00:00:00.000Z') - ${8 * 3600_000})`
/** offline_gate_decision (ml-controller model_artifact_registry): STRONG_PASS and PASS serve; WEAK_PASS is evidence only. */
const SERVING_GATES = `['STRONG_PASS', 'PASS']`
const GATE_VOCAB = { STRONG_PASS: ['強通過', 'ok'], PASS: ['通過', 'ok'], WEAK_PASS: ['弱通過', 'warn'], FAIL: ['未過', 'bad'], PENDING: ['待定', 'idle'] }
/** The next monthly run in Taiwan time; the repo manifest's PAUSED reads 暫停 (the Worker then serves no date). */
const NEXT_MONTHLY = `next_monthly_run.repo_desired_state = 'PAUSED' ? '暫停'
  : next_monthly_run.next_run_at ? $fromMillis($toMillis(next_monthly_run.next_run_at), '[M01]/[D01]', '+0800') : '—'`

/** Page ④: is the strategy earning, which model is weak, is the allocator learning, and how long training runs. */
function model(q) {
  const gcp = gcpPanels()
  const nav = (field, name) => q(NAV, { root: `rows.{ 'time': ${DAY_TIME('date')}, 'v': ${field} }`, columns: [T('time', 'time'), N('v', name)] })
  return [
    spark('Paper 報酬', nav('nav_return_pct', '報酬'), 0, 0, 5, 4, { unit: 'percent', dec: 2, desc: 'Paper 帳戶 NAV 相對 90 天窗口第一天的報酬；折線＝每天。' }),
    spark('相對加權指數', nav('excess_return_pct', '超額'), 5, 0, 5, 4, { unit: 'percent', dec: 2, desc: 'Paper 報酬減加權指數報酬（同一窗口、各自以第一天為基準）。' }),
    spark('回撤', nav('drawdown_pct', '回撤'), 10, 0, 5, 4, { unit: 'percent', dec: 2, th: th([C.warn, null], [C.txt, -10]), desc: '離窗口內最高 NAV 的距離；低於 −10% 標琥珀。' }),
    kpi('OPB', [q(OPB, { root: `{ 'clip': summary.clip_rate, 'reward': summary.complete_receipts, 'days': summary.plan_days }`,
      columns: [N('clip', '被壓成一組'), N('reward', '可學 reward'), N('days', '計畫天數')] })], 15, 0, 5, 4, [
      { name: '被壓成一組', unit: 'percentunit', th: th([C.txt, null], [C.warn, 0.5]) }, { name: '可學 reward' }, { name: '計畫天數' }]),
    kpi('模型', [q(ROSTER, { root: `{ 'pass': $string($count(rows[gate_decision in ${SERVING_GATES}])) & '／' & $string(model_count),
      'next': ${NEXT_MONTHLY} }`,
      columns: [S('pass', '閘門通過'), S('next', '下次月訓')] })], 20, 0, 4, 4, [{ name: '閘門通過' }, { name: '下次月訓' }]),
    { type: 'timeseries', title: 'Paper NAV 與加權指數', gridPos: gp(0, 4, 14, 9),
      description: '兩條線都以 90 天窗口第一天為 0%。加權指數收盤晚於 paper 快照，最後一天可能還沒有指數。',
      targets: [q(NAV, { root: `rows.{ 'time': ${DAY_TIME('date')}, 'nav': nav_return_pct, 'twii': twii_return_pct }`,
        columns: [T('time', 'time'), N('nav', 'Paper NAV'), N('twii', '加權指數')] })],
      options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: ['lastNotNull'] }, tooltip: { mode: 'multi' } },
      fieldConfig: { defaults: { unit: 'percent', decimals: 1, noValue: NO_SOURCE, custom: { drawStyle: 'line', lineWidth: 2, fillOpacity: 0, spanNulls: true } },
        overrides: [['Paper NAV', COOL.cat[0]], ['加權指數', C.sub]].map(([name, color]) => ({ matcher: { id: 'byName', options: name },
          properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } },
    states('state-timeline', '每天選到的 OPB arm', q(OPB, { root: `rows.{ 'time': ${DAY_TIME('signal_date')}, 'row': '選到的 arm', 'arm': arm_inert ? 'arm_inert' : arm_id }`,
      columns: [T('time', 'time'), S('row', 'row'), S('arm', 'arm')] }), 'row', 14, 4, 10, 4,
    { mappings: ARM_MAPPINGS, legend: true, desc: '每個 signal date 的計畫用了哪個 arm；灰＝風控把所有 arm 壓成同一組，那天學不到差別。' }),
    stackedBars('各 arm 累積樣本（最新有統計的計畫）', [q(OPB, { root: `latest_arm_statistics.{ 'arm': arm_id, 'samples': samples }`,
      columns: [S('arm', 'arm'), N('samples', '樣本數')] })], 'arm', 14, 8, 10, 5, [['樣本數', COOL.cat[0]]],
    { horizontal: true, desc: '最新一筆有 arm 統計的計畫：每個 arm 累積多少樣本（v2 從 replay 學）。所有 arm 被壓成同一組或固定 arm 那天的計畫統計是空的，往前取；統計按 context 算，可能早於目前的 context。' }),
    table('模型名冊', q(ROSTER, { root: `rows.{ 'model': model_name, 'gate': gate_decision, 'ic': oos_ic, 'min': min_oos_ic_mean, 'state': state,
      'version': '版本 ' & champion_version, 'run': source_run_date ? '訓練資料 ' & source_run_date : '訓練資料 —' }`,
      columns: [S('model', '模型'), S('gate', '閘門'), N('ic', 'OOS IC'), N('min', 'IC 門檻'), S('state', '狀態'), S('version', '版本'), S('run', '訓練')] }),
    0, 13, 14, 7, { status: ['閘門'], vocabulary: GATE_VOCAB, wd: { 閘門: 64, 'OOS IC': 84, 'IC 門檻': 84 }, hidden: ['版本', '訓練'], details: { 模型: ['版本', '訓練'] },
      desc: '上線中的 alpha roster 與各模型最近一次月訓的離線閘門。點模型名稱看版本與訓練資料日。' }),
    at(gcp.jobMinutes, 14, 13, 10, 7),
    states('status-history', 'KV 設定漂移（7 天）', q(KV_DRIFT, {
      // Inside ['a', 'b'].{ … } `$` is not the key string in Infinity's JSONata (and $lookup needs a string), so each key is bound as $k first.
      root: `$sort(rows, function($a, $b) { $a.business_date > $b.business_date }).($r := $; ['trading:config', 'trading:risk_config'].($k := $string($);
        { 'time': ${DAY_TIME('$r.business_date')}, 'key': $k, 'status': $lookup($r, $k) }))`,
      columns: [T('time', 'time'), S('key', 'key'), S('status', 'status')] }), 'key', 0, 20, 12, 4,
    { opts: { colWidth: 0.9 }, desc: '每晚 kv-config-drift 對 manifest digest 的比對結果；漂移＝KV 現值與 repo manifest 不同（Optuna 月搜直推後屬預期）。' }),
    Object.assign(kpi('證據累積（execution parity、RFS allocator）', [
      q(CLOCKS, { root: `$merge([details.execution_parity, { 'k': 1 }])`, columns: [KPI_KEY, N('real_intents', '真實意圖'), N('paper_intents', 'paper 意圖'), N('matched_intents', '對得上')], refId: 'A' }),
      // blocked_receipts and mature_*_session_dates are null by design until the Worker can read them without a full scan
      // (details.rfs_allocator.not_served), so the strip shows the mechanism's status and evidence days instead.
      q(CLOCKS, { root: `{ 'k': 1, 'n': details.rfs_allocator.candidate_count, 'status': rows[mechanism = 'rfs_allocator'][0].status,
        'days': rows[mechanism = 'rfs_allocator'][0].distinct_dates }`, columns: [KPI_KEY, N('n', '候選數'), S('status', 'RFS 狀態'), N('days', '證據日數')], refId: 'B' }),
    ], 12, 20, 12, 4, [{ name: '真實意圖' }, { name: 'paper 意圖' }, { name: '對得上' }, { name: '候選數' },
      { name: 'RFS 狀態', mappings: statusMappings('text') }, { name: '證據日數' }]),
    { description: 'execution parity：真實下單意圖、paper 意圖與兩邊對得上的筆數。RFS allocator：候選數、收集狀態與已有證據的日數；'
      + '被擋的收據與滿 20 日的日數要等 RFS 比較表有索引後 Worker 才提供（目前回 null）。' }),
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
/* ---- sv-mobile: read on a 375 px phone ----
 * A table there has 331 px inside, a row is 36 px and does not grow (wrapText did not raise a row on the deployed
 * Grafana, measured 11/26), so every cell's words must fit one line and every table its rows. Grafana's TableNG keeps
 * a configured custom.width exactly, and gives an auto column the rest (computeColWidths) or its content width
 * (content-aware widths), so each phone table is fixed-width short columns plus one auto column with a 50 px floor;
 * the build fails when a possible value would not fit its column, or the columns the phone width. */
const PHONE_W = 331
const ROW_PX = 36
/** Rendered width at the table's 14 px font: CJK and full-width forms 14, capitals and digits 8.5, narrow punctuation 4,
 * other Latin 7.5 — plus 8% margin and the cell's 17 px of padding and border. */
const textPx = (text) => [...String(text)].reduce((sum, ch) => sum + (/[①-⓿⺀-鿿＀-￯　-〿]/.test(ch) ? 14
  : /[A-Z0-9mwMW]/.test(ch) ? 8.5 : /[ .,·|:;il1!'\-\/()]/.test(ch) ? 4 : 7.5), 0)
const cellPx = (text) => Math.ceil(textPx(text) * 1.08) + 17
/** A header needs its words plus padding and the sort arrow's space (38 px; 50 at the first and last column, measured:
 * 鏈 at 52 px and 次數 at 52 px were cut by a few px, 狀況 at 64 px was not). */
const headerPx = (header, edge) => Math.ceil(textPx(header)) + (edge ? 50 : 38)
function fitColumn(where, header, texts, width, edge = false) {
  const worst = [...texts].sort((a, b) => cellPx(b) - cellPx(a))[0] ?? ''
  if (cellPx(worst) > width) throw new Error(`${where}: 「${worst}」 needs ${cellPx(worst)} px, column ${header} has ${width}`)
  if (headerPx(header, edge) > width) throw new Error(`${where}: header ${header} needs ${headerPx(header, edge)} px, the column has ${width}`)
}
/** Grid units for a table with a header and `rows` rows: a panel h units high has 38h − 61 px inside (h6 measured 167). */
const tableUnits = (rows) => Math.ceil(((rows + 1) * ROW_PX + 61) / 38)
const PHONE_TONES = () => toneMappings([['bad', TONE.bad.text], ['warn', TONE.warn.text], ['run', TONE.run.text], ['idle', TONE.idle.text], ['ok', TONE.ok.text], ['skip', TONE.skip.text]])
/** A phone table: `auto` takes what the fixed columns leave; `tone` columns read "<tone>|<words>"; `hidden` columns
 * open from `details` (a tap on that cell). */
function phoneTable(title, target, y, rows, { auto, fixed, tone = [], hidden = [], details = {}, empty, desc }) {
  const names = target.columns.map((c) => c.text)
  const visible = names.filter((name) => !hidden.includes(name))
  const used = Object.values(fixed).reduce((sum, width) => sum + width, 0)
  if (used + 50 > PHONE_W) throw new Error(`${title}: fixed columns take ${used} of ${PHONE_W} px`)
  const panel = table(title, target, 0, y, 24, tableUnits(rows), { wd: fixed, mw: { [auto]: 50 }, hidden, details, empty, desc })
  for (const name of tone) panel.fieldConfig.overrides.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: PHONE_TONES() }] })
  return Object.assign(panel, { phone: { auto, width: PHONE_W - used, first: visible[0], last: visible.at(-1) } })
}
/** Checks every visible column of a phone table against the words it can show (tone prefixes stripped). */
function fitPhone(panel, values) {
  for (const [name, texts] of Object.entries(values)) {
    const width = name === panel.phone.auto ? panel.phone.width : panel.fieldConfig.overrides.find((o) => o.matcher.options === name
      && o.properties.some((x) => x.id === 'custom.width')).properties.find((x) => x.id === 'custom.width').value
    fitColumn(panel.title, name, texts.map((t) => String(t).replace(/^[a-z]+\|/, '')), width, name === panel.phone.first || name === panel.phone.last)
  }
  delete panel.phone
  return panel
}

const ERROR_BRIEFS = Object.fromEntries([...readFileSync(join(here, '../../../worker/src/monitoring/errorBrief.ts'), 'utf8')
  .match(/ERROR_BRIEF = \{([^}]*)\}/)[1].matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]))
if (ERROR_BRIEFS.other !== ERROR_FALLBACK) throw new Error('ERROR_FALLBACK drifted from the Worker ERROR_BRIEF.other')
/** A phone's error words, short enough for its 原因 column: each Worker brief in fewer characters, the catch-all as where
 * to look. A brief the Worker adds without a short form here fails the build. */
const PHONE_BRIEF_WORDS = { overloaded: '資料庫過載', timeout: '執行逾時', upstream: '上游未就緒', quota: '額度用盡', unavailable: '服務不可用',
  other: '細節見 log' }
for (const key of Object.keys(ERROR_BRIEFS)) if (!PHONE_BRIEF_WORDS[key]) throw new Error(`phone brief: no short words for ${key}`)
const PHONE_BRIEF = JSON.stringify(Object.fromEntries(Object.entries(ERROR_BRIEFS).map(([key, brief]) => [brief, PHONE_BRIEF_WORDS[key]])))
const phoneBrief = (brief = 'error_brief', raw = 'error') => `(${brief} ? ($w := $lookup(${PHONE_BRIEF}, ${brief}); $w ? $w : '細節見 log') : ${raw} ? '細節見 log' : '無訊息')`
/** Stage names on a phone: the Canvas's short names, and the parents' short names. */
const PHONE_LABELS = Object.fromEntries([...Object.entries(dag.stages).map(([id, stage]) => ({ id, label: stage.label })), ...dag.catalog, ...Object.values(OTHER).flatMap((chain) => Object.entries(chain.stages).map(([id, stage]) => ({ id, label: stage.label })))]
  .map((stage) => [stage.id, SHORT_LABELS[stage.id] ?? ({ pipeline: 'L3 Pipeline', 'ml-predict': 'ML Predict' })[stage.id] ?? stage.label]))
const PHONE_CHAIN = { daily_readiness: '日', intraday_guard: '盤', weekly_research: '週', monthly_artifact: '月' }
const phoneStage = `$lookup(${JSON.stringify(PHONE_CHAIN)}, ${ROW_CHAIN}) & ' ' & ($n := $lookup(${JSON.stringify(PHONE_LABELS)}, stage_id); $n ? $n : label ? label : '其他站')`
const PHONE_STAGES = Object.values(PHONE_CHAIN).flatMap((chain) => Object.values(PHONE_LABELS).map((label) => `${chain} ${label}`))
/** The longest SHORT_DURATION text, for the width checks. */
const DURATIONS = ['59 分', '23.9 h', '99.9 天']

/** sv-mobile's 流程鏈: the daily chain as a list (Wei 11/26, option a: on a phone the canvas scales its 39 boxes too small
 * to read). Worst first — 失敗, 中止／漏跑, 逾時, 卡住, 被擋住, 趕不上, 應跑未跑, 執行中, 等待中 — then the chain's order;
 * past MOBILE_ROWS stages the last row counts the rest, and the finished / skipped and the not-started stages are one
 * row each (at most MOBILE_ROWS + 2 rows). A failure reads its error_brief; a running stage how long it has run. */
const MOBILE_ROWS = 6
const MOBILE_RANK = JSON.stringify({ failed: 1, error: 1, blocked: 2, missed: 2, overdue: 3, stuck: 4, watcher_blocked: 5, at_risk: 6, attention: 7,
  running: 8, waiting: 9 })
const MOBILE_FAILED = ['failed', 'error', 'blocked', 'missed', 'stuck']
const MOBILE_TIMED = ['running', 'stuck', 'overdue', 'at_risk']
const MOBILE_DONE = `['completed', 'success', 'noop', 'retry_success', 'skipped']`
/** Status words on a phone: 趕不上截止 is 趕不上 there, so 「趕不上・已 99.9 天」 fits the column. */
const MOBILE_WORD = (key) => key === 'at_risk' ? '趕不上' : STATUS[key][0]
const MOBILE_WORDS = JSON.stringify(Object.fromEntries(Object.keys(STATUS).map((key) => [key, MOBILE_WORD(key)])))
const STATUS_TONES = JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([key, [, tone]]) => [key, tone])))
const MOBILE_CHAIN = `(
  $label := ${MOBILE_WORDS}; $tone := ${STATUS_TONES}; $rank := ${MOBILE_RANK}; $names := ${JSON.stringify(PHONE_LABELS)};
  $now := $toMillis($$.generated_at);
  $watch := function($r) { $type($r.watcher) = 'boolean' ? $r.watcher : $r.stage_id in ${WATCHERS} };
  $ds := function($r) { $r.display_status = 'blocked' and $watch($r) ? 'watcher_blocked' : $r.display_status };
  $rk := function($r) {( $k := $lookup($rank, $ds($r)); $k ? $k : 99 )};
  $pos := function($r) {( $p := $r.position; $type($p) = 'number' ? $p : 999 )};
  $rows := $$.rows[active = true and stage_id];
  $done := $rows[$ds($) in ${MOBILE_DONE}];
  $items := $sort($rows[$rk($) < 99], function($a, $b) { $rk($a) = $rk($b) ? $pos($a) > $pos($b) : $rk($a) > $rk($b) });
  $todo := $count($rows) - $count($done) - $count($items);
  $n := $count($items);
  $word := function($r) {(
    $s := $ds($r); $l := $lookup($label, $s); $t := $lookup($tone, $s); $l := $l ? $l : '狀態異常';
    $b := $r.error_brief ? ($w := $lookup(${PHONE_BRIEF}, $r.error_brief); $w ? $w : '細節見 log') : $r.error ? '細節見 log' : '';
    $m := $r.started_at ? ($now - $toMillis($r.started_at)) / 60000 : null;
    ($t ? $t : 'idle') & '|' & (
      $s in ${JSON.stringify(MOBILE_FAILED)} and $b ? ($b = '細節見 log' ? $l & '（細節見 log）' : $l & '：' & $b)
      : $s in ${JSON.stringify(MOBILE_TIMED)} and $r.started_at and $not($r.completed_at) ? $l & '・已 ' & ${SHORT_DURATION('$m')}
      : $l)
  )};
  $shown := ($n > ${MOBILE_ROWS} ? $items[[0..${MOBILE_ROWS - 2}]] : $items).{ 'stage': ($m := $lookup($names, stage_id); $m ? $m : label ? label : '其他站'), 'status': $word($) };
  $out := $append($append($append($shown,
    $n > ${MOBILE_ROWS} ? [{ 'stage': '另有 ' & $string($n - ${MOBILE_ROWS - 1}) & ' 站', 'status': 'idle|看完整版' }] : []),
    $count($done) > 0 ? [{ 'stage': '其他 ' & $string($count($done)) & ' 站', 'status': 'ok|已完成／略過' }] : []),
    $todo > 0 ? [{ 'stage': '其他 ' & $string($todo) & ' 站', 'status': 'idle|未開始' }] : []);
  $count($out) > 0 ? $out : []
)`
const MOBILE_STATUSES = (() => {
  const words = Object.keys(JSON.parse(MOBILE_RANK)).map((key) => [key, MOBILE_WORD(key)])
  return [...words.flatMap(([key, word]) => [word,
    ...(MOBILE_FAILED.includes(key) ? [...Object.values(PHONE_BRIEF_WORDS).filter((b) => b !== '細節見 log').map((b) => `${word}：${b}`), `${word}（細節見 log）`] : []),
    ...(MOBILE_TIMED.includes(key) ? DURATIONS.map((d) => `${word}・已 ${d}`) : [])]), '狀態異常', '看完整版', '已完成／略過', '未開始']
})()

/** 要處理 / 失敗中的階段 / 資料就緒 on a phone: worst first, past `rows` the last row counts the rest. */
const PHONE_TODO_ROWS = 5
const PHONE_LIST_ROWS = 4
const ALERT_TONES = JSON.stringify({ failed: 'bad', missed: 'bad', stuck: 'bad', blocked: 'warn', overdue: 'warn' })
const capped = (items, rows, more) => `($all := ${items}; $n := $count($all); $out := ($n > ${rows} ? $all[[0..${rows - 2}]] : $all);
  $out := $n > ${rows} ? $append($out, [${more(`$string($n - ${rows - 1})`)}]) : $out; $count($out) > 0 ? $out : [])`

function mobile(q) {
  const chain = fitPhone(phoneTable('流程鏈（每日）', q(STATE, { root: MOBILE_CHAIN, columns: [S('stage', '站'), S('status', '狀態')] }), 3, MOBILE_ROWS + 2,
    { auto: '狀態', fixed: { 站: 154 }, tone: ['狀態'], empty: '今天的流程鏈還沒有資料',
      desc: '每日鏈每一站的狀態，最嚴重的在上：失敗、中止／漏跑、逾時、卡住、被擋住、趕不上（截止）、應跑未跑、執行中、等待中；'
        + `超過 ${MOBILE_ROWS} 站時最後一列寫還有幾站，已完成／略過與未開始的站各收成一列。失敗的站寫原因，執行中的站寫已跑多久。完整的流程圖在桌機版「今天」頁。` }),
  { 站: [...Object.values(PHONE_LABELS), '另有 99 站', '其他 99 站', '其他站'], 狀態: MOBILE_STATUSES })
  let y = 3 + chain.gridPos.h
  const todo = fitPhone(phoneTable('要處理', q(ALERTS, { root: capped(`$sort(rows, function($a, $b) {(
        $ra := $lookup(${TODO_RANK}, $a.kind); $rb := $lookup(${TODO_RANK}, $b.kind); $ra := $ra ? $ra : 9; $rb := $rb ? $rb : 9;
        $ra = $rb ? $a.failures_14d < $b.failures_14d : $ra > $rb )}).{ 'item': ${phoneStage},
        'state': ($k := ${ALERT_KIND()}; $t := $lookup(${ALERT_TONES}, kind); ($t ? $t : 'warn') & '|' & $lookup(${STATUS_LABELS_JSONATA}, $k) & '・' & ${SHORT_DURATION('minutes')}),
        'reason': '原因：' & ${phoneBrief()}, 'when': '業務日 ' & business_date & (expected_by ? '｜截止 ' & $fromMillis($toMillis(expected_by), '[M01]/[D01] [H01]:[m01]', '+0800') : '') }`,
      PHONE_TODO_ROWS, (n) => `{ 'item': '另有 ' & ${n} & ' 筆', 'state': 'idle|看完整版', 'reason': '', 'when': '' }`),
    columns: [S('item', '事項'), S('state', '狀況'), S('reason', '原因'), S('when', '時間')] }), y, PHONE_TODO_ROWS,
    { auto: '事項', fixed: { 狀況: 130 }, tone: ['狀況'], hidden: ['原因', '時間'], details: { 事項: ['原因', '時間'] }, empty: '沒有需要處理的事項',
      desc: `四條鏈裡失敗、逾時、卡住、漏跑的站，和過了 09:10 仍被擋住的盤中監控，最嚴重的在上；超過 ${PHONE_TODO_ROWS} 筆時最後一列寫還有幾筆。`
        + '日／盤／週／月＝每日、盤中、每週、每月鏈；狀況後＝這個狀況已經多久。點事項看原因與截止。' }),
  { 事項: [...PHONE_STAGES, '另有 99 筆'], 狀況: [...['失敗', '漏跑', '卡住', '逾時', '被擋住'].flatMap((w) => DURATIONS.map((d) => `${w}・${d}`)), '看完整版'] })
  y += todo.gridPos.h
  const margin = marginTable(q, '未完成的必要階段（離截止還剩多久）', 0, y, 24, 8, { hide: ['截止'] })
  y += margin.gridPos.h
  const problem = `status != 'ok' and status != 'ready'`
  const readyWord = (latest) => `($v := $lookup(${JSON.stringify(Object.fromEntries(Object.entries(READINESS_VOCAB).map(([k, [w, t]]) => [k, `${t}|${w}`])))}, status);
    ($v ? $v : 'warn|異常') & (${latest} ? '・' & $replace($substring(${latest}, 5), '-', '/') : ''))`
  const readiness = fitPhone(phoneTable('資料就緒：只列有問題的', q(READINESS, { root: capped(`$sort($append(
        rows[${problem}].{ 'rank': $lookup(${READINESS_RANK}, status), 'name': label, 'state': ${readyWord('latestDate')},
          'note': ${READINESS_ROWS('value')} & '｜' & ${READINESS_DETAIL('detail')} },
        checks[${problem} and id != 'market_dashboard_materialization'].{ 'rank': $lookup(${READINESS_RANK}, status), 'name': ($n := $lookup(${CHECK_NAMES}, id); $n ? $n : label),
          'state': ${readyWord('latest_date')}, 'note': ${CHECK_DETAIL} }),
      function($a, $b) { ($type($a.rank) = 'number' ? $a.rank : 9) > ($type($b.rank) = 'number' ? $b.rank : 9) })`,
      PHONE_LIST_ROWS, (n) => `{ 'name': '另有 ' & ${n} & ' 項', 'state': 'idle|看完整版', 'note': '' }`),
    columns: [S('name', '項目'), S('state', '狀態'), S('note', '說明')] }), y, PHONE_LIST_ROWS,
    { auto: '項目', fixed: { 狀態: 104 }, tone: ['狀態'], hidden: ['說明'], details: { 項目: ['說明'] }, empty: '全部到齊',
      desc: `沒到齊的資料集，缺漏在前；狀態後＝最新一筆資料的日期；超過 ${PHONE_LIST_ROWS} 項時最後一列寫還有幾項。點項目看說明。` }),
  { 項目: [...readFileSync(join(here, '../../../worker/src/monitoring/dataReadiness.ts'), 'utf8').matchAll(/label: '([^']*)'/g)].map((m) => m[1])
      .concat(Object.values(JSON.parse(CHECK_NAMES)), '另有 99 項'),
    狀態: Object.values(READINESS_VOCAB).map(([w]) => `${w}・12/31`).concat('異常・12/31', '看完整版') })
  y += readiness.gridPos.h
  const failed = fitPhone(phoneTable('失敗中的階段', q(ALERTS, { root: capped(`$sort(rows[kind = 'failed'],
        function($a, $b) { $a.failures_14d < $b.failures_14d }).{ 'stage': ${phoneStage},
        'reason': ($t := failures_14d >= 2 ? 'bad|' : 'warn|'; $t & ${phoneBrief()} & '・' & $string(failures_14d) & ' 次') }`,
      PHONE_LIST_ROWS, (n) => `{ 'stage': '另有 ' & ${n} & ' 站', 'reason': 'idle|看完整版' }`),
    columns: [S('stage', '階段'), S('reason', '原因')] }), y, PHONE_LIST_ROWS,
    { auto: '階段', fixed: { 原因: 150 }, tone: ['原因'], empty: '沒有失敗中的階段',
      desc: `失敗中的階段，近 14 天失敗最多的在上；原因後＝近 14 天第幾次（2 次起紅字）；超過 ${PHONE_LIST_ROWS} 站時最後一列寫還有幾站。日／盤／週／月＝每日、盤中、每週、每月鏈。` }),
  { 階段: [...PHONE_STAGES, '另有 99 站'], 原因: [...Object.values(PHONE_BRIEF_WORDS), '無訊息'].map((b) => `${b}・14 次`).concat('看完整版') })
  return [verdict(q, 0, 0, 24, 3), chain, todo, margin, readiness, failed]
}

/* ---- v5 preview pages (dashboard_rethink_v5.md §2–3): each question gets the chart its data shape asks for. ---- */

/** Grid row names: the Canvas's short names, and the two parents the Canvas draws as their sub-stages. */
const SLACK_LABELS = { ...SHORT_LABELS, pipeline: 'L3 Pipeline', 'ml-predict': 'ML Predict', 'finlab-v4-backfill': 'FinLab canonical' }
const SLACK_NAMES = JSON.stringify(SLACK_LABELS)
/** The L3 Pipeline deadline from the Worker's stage catalog, in minutes after the business date's Taiwan midnight:
 * ntd('HH:MM') is that time on the next trading day, drawn as the next morning (a weekday's next trading day). */
const PIPELINE_DEADLINE = (() => {
  const match = /stageId: 'pipeline',.*expectedBy: ntd\('(\d\d):(\d\d)'\)/.exec(readFileSync(join(here, '../../../worker/src/lib/opsChainStageCatalog.ts'), 'utf8'))
  if (!match) throw new Error('pipeline deadline not found in opsChainStageCatalog.ts')
  return 24 * 60 + Number(match[1]) * 60 + Number(match[2])
})()
/** Clock times are drawn on one reference day so the axis reads HH:mm: the value is this base plus the time since the
 * business date's Taiwan midnight (the history row's `time`). */
const CLOCK_BASE = Date.parse('2000-01-01T00:00:00+08:00')
const MIN_MS = 60_000
/** A history row that finished: completed_at is set only for a final status, and only a success is measured. */
const SLACK_ROWS = `rows[optional = false and status = 'success' and completed_at and expected_by]`
/** A spark (number + line) moved to another column. */
const moveSpark = (panels, x, w) => [panels].flat().map((panel) => Object.assign(panel, { gridPos: { ...panel.gridPos, x, w } }))
/** State timeline over Cloud Monitoring series, one row per series: grey when nothing runs, blue when something does. */
const gcpStates = (title, target, x, y, w, h, o = {}) => ({ type: 'state-timeline', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: GCP_DS,
  targets: [target], timeFrom: o.timeFrom, hideTimeOverride: true,
  options: { showValue: 'never', rowHeight: 0.7, mergeValues: true, alignValue: 'left', legend: { showLegend: false, displayMode: 'list', placement: 'bottom' },
    tooltip: { mode: 'single' } },
  fieldConfig: { defaults: { noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' }, thresholds: th([C.dim, null], [C.run, 0.5]),
    mappings: [{ type: 'value', options: { 0: { text: o.off ?? '沒有', index: 0 } } }, { type: 'range', options: { from: 0.5, to: 1e9, result: { text: o.on, index: 1 } } }],
    custom: { fillOpacity: 100, lineWidth: 0 } }, overrides: [] } })

function today5(q) {
  const panels = today(q)
  const state = (root, columns, refId) => q(STATE, { root, columns, refId })
  const active = 'current[active = true]'
  const counts = [state(`${active}.{ 'done': required_done }`, [N('done', '完成')], 'A'),
    state(`${active}.{ 'total': required_total, 'all': required_total, 'unit': 'suffix: / ' & $string(required_total) }`,
      [N('total', 'total'), N('all', 'all'), S('unit', 'unit')], 'B')]
  // The total is both the arc's end and its unit, so the number reads "9 / 26".
  Object.assign(panels[0], { targets: counts, datasource: counts[0].datasource, description: '這一輪已完成的必要階段／必要階段總數；全部完成時轉綠。',
    transformations: [{ id: 'configFromData', options: { configRefId: 'B', mappings: [{ fieldName: 'total', handlerKey: 'max' },
      { fieldName: 'all', handlerKey: 'threshold1' }, { fieldName: 'unit', handlerKey: 'unit' }] } }] })
  return panels
}

function health5(q) {
  const v4 = health(q)
  const [daily, intraday] = HISTORIES
  const deadline = PIPELINE_DEADLINE
  const clock = (minutes) => CLOCK_BASE + minutes * MIN_MS
  const repeat = v4.find((panel) => panel.title === '重複失敗')
  // 「每週」needs 50px with padding; at 48 the grid overflows by 2px and draws a horizontal scrollbar.
  repeat.fieldConfig.overrides.find((o) => o.matcher.options === '鏈').properties.find((p) => p.id === 'custom.width').value = 52
  const lane = (id) => v4.find((panel) => panel.title === OTHER_TITLES[id])
  const troubled = ([path, name], refId, order) => q(path, { refId, columns: [T('time', 'time'), S('stage', 'stage'), S('result', 'result')],
    // Infinity serves an empty match as a frame without fields, which the state timeline reports as "Data does not have a
    // time field" instead of its noValue; a quiet window is one 正常 row over the whole window.
    root: `($bad := $distinct(rows[result in ['error', 'blocked', 'retry_success']].stage_id); $bad ? ${order('rows[stage_id in $bad]')}.{ 'time': time,
      'stage': '${name}｜' & label, 'result': ${RESULT} } : { 'time': ${DAY_TIME('from')}, 'stage': '${name}｜14 天內沒有站出狀況', 'result': 'ok' })` })
  // A count of past failures is not an alert by itself (they are listed below); amber only from about one a business day.
  Object.assign(v4[2][0].fieldConfig.defaults, { thresholds: th([C.txt, null], [C.warn, 10]) })
  v4[2][0].description = '近 14 個業務日失敗或中止的站次合計（10 次以上標琥珀）；折線＝每天幾站。'
  // Long rows (time, stage, margin) split into one row per stage, in order of first appearance (Canvas order), as the state panels do.
  const byStage = (panel) => Object.assign(panel, { transformations: [...panel.transformations,
    { id: 'partitionByValues', options: { fields: ['stage'], keepFields: false, naming: { asLabels: true } } }],
  fieldConfig: { ...panel.fieldConfig, defaults: { ...panel.fieldConfig.defaults, displayName: '${__field.labels.stage}' } } })
  return [
    ...v4.slice(0, 4),
    // A status-history grid (one row per stage, one cell per business day) so each band is a flat colour, not a gradient.
    byStage(grid('距截止的餘裕（必要階段 × 業務日）', q(HISTORY, { root: `${byChainOrder(SLACK_ROWS, 'time')}.{ 'time': time,
      'stage': ($n := $lookup(${SLACK_NAMES}, stage_id); $n ? $n : label), 'margin': $round(($toMillis(expected_by) - $toMillis(completed_at)) / ${MIN_MS}) }`,
    columns: [T('time', 'time'), S('stage', 'stage'), N('margin', '餘裕')] }),
      0, 4, 16, 12, { unit: 'm', th: th([C.bad, null], [C.warn, 0], [COOL.margin[0], 10], [COOL.margin[1], 30], [COOL.margin[2], 60]),
        desc: '一格＝一個必要階段一個業務日，顏色＝完成時離截止還剩幾分鐘：深藍＝60 分以上，青＝30–60 分，灰藍＝10–30 分，'
          + '琥珀＝不到 10 分（快趕不上），紅＝超過截止（與今天頁流程鏈的底色同一組門檻）。同一列由左往右變淺、變琥珀＝這一站越跑越慢。列順序＝今天頁的流程鏈。'
          + '只算成功完成的必要階段（截止－完成時間）；失敗、略過、還沒完成的格子是空的。截止是下一個交易日的站，週五的餘裕會多出週末。' })),
    donut('失敗分類（14 天）', q(FAILURE_CLASSES, { root: `{ '最終失敗': classes.final_failure, '上游擋下': classes.upstream_blocked,
      '重試後成功': classes.recovered, '進行中': classes.in_progress, '其他': classes.orphan_running + classes.unsettled_triggered + classes.designed_retry }`,
    columns: FAILURE_CLASS_SERIES.map(([name]) => N(name, name)) }), 16, 4, 8, 12, { colors: FAILURE_CLASS_SERIES.map(([name, , color]) => [name, color]),
      desc: `14 天內非成功的 scheduler ticket 各類占比，${FAILURE_CLASS_NOTE}` }),
    { type: 'timeseries', title: 'L3 Pipeline 收尾時間', gridPos: gp(0, 16, 10, 8),
      description: `每個業務日夜間 L3 Pipeline 全部完成的時間（隔天早上），虛線＝截止 ${new Date(clock(deadline) + 8 * 3600_000).toISOString().slice(11, 16)}；`
        + '紅區＝超過截止、琥珀＝截止前 15 分內。點越來越往上＝夜鏈越跑越晚。只畫成功完成的業務日。',
      // The clock time is the time since the business date's Taiwan midnight (`time`) on CLOCK_BASE's day.
      targets: [q(HISTORY, { root: `rows[stage_id = 'pipeline' and status = 'success' and completed_at].{ 'time': time,
        'tail': ${CLOCK_BASE} + $toMillis(completed_at) - $toMillis(time) }`, columns: [T('time', 'time'), N('tail', '完成時間')] })],
      options: { legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'single' } },
      // Only the last 15 minutes before the deadline (amber) and past it (red) are shaded; before that nothing.
      fieldConfig: { defaults: { noValue: NO_SOURCE, color: { mode: 'fixed', fixedColor: COOL.cat[0] },
        thresholds: th(['transparent', null], [C.warn, clock(deadline - 15)], [C.bad, clock(deadline)]),
        custom: { drawStyle: 'line', lineWidth: 2, lineInterpolation: 'linear', showPoints: 'always', pointSize: 6, fillOpacity: 0, spanNulls: true,
          axisSoftMin: clock(deadline - 120), axisSoftMax: clock(deadline + 20), thresholdsStyle: { mode: 'line+area' } } },
        // On the value only: in the defaults the time axis would read HH:mm too.
        overrides: [{ matcher: { id: 'byName', options: '完成時間' }, properties: [{ id: 'unit', value: 'time:HH:mm' }] }] } },
    states('state-timeline', '出過狀況的站（14 天）', [troubled(daily, 'A', (rows) => byChainOrder(rows, 'time')),
      troubled(intraday, 'B', (rows) => `$sort(${rows}, function($a, $b) { $a.position > $b.position or ($a.position = $b.position and $a.time > $b.time) })`)],
    'stage', 10, 16, 14, 8, { empty: '14 天內沒有', opts: { mergeValues: true },
      desc: '只列 14 天內失敗、中止或重試後才完成過的站（每日＋盤中），一列＝一站每個業務日的最終結果；一條鏈全部正常時只顯示一列「14 天內沒有站出狀況」。' }),
    ...['weekly_research', 'monthly_artifact'].map((id, i) => Object.assign(lane(id), { gridPos: gp(i ? 16 : 0, 24, i ? 8 : 16, 6) })),
    Object.assign(lane('intraday_guard'), { gridPos: gp(0, 30, 11, 8) }),
    Object.assign(repeat, { gridPos: gp(11, 30, 13, 8) }),
  ]
}
const OTHER_TITLES = { weekly_research: '每週研究', monthly_artifact: '每月 artifact', intraday_guard: '盤中守門與收盤帳務' }

const REQUESTS = ['resource.type', '=', 'cloud_run_revision', 'AND', 'metric.type', '=', 'run.googleapis.com/request_count']
const LATENCIES = ['resource.type', '=', 'cloud_run_revision', 'AND', 'metric.type', '=', 'run.googleapis.com/request_latencies']
/** Placeholder monthly budget for the cost line (示範值; Wei has not set one). */
const MONTH_BUDGET_TWD = 2000
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

function resources5(q, mode) {
  const cost = costPanels(q, mode)
  const d1Grid = (prefix) => q('plan:cloudflare-d1-grid', { root: 'rows', columns: [T('time', 'time'), ...HOURS.map((h) => N(`${prefix}${h}`, h))] })
  return [
    ...moveSpark(cost.month, 0, 6), ...moveSpark(cost.forecast, 6, 5), ...moveSpark(cost.latest, 11, 6),
    ...spark('Cloud Run 請求', gcpSeries('A', REQUESTS, null, 'ALIGN_SUM', '+3600s', '請求'), 17, 0, 7, 4,
      { calc: 'sum', unit: 'short', desc: '所選時間內所有 Cloud Run 服務的請求數合計；折線＝每小時。' }),
    gauges('D1 各資料庫用量', q(CAPACITY, { root: `$sort(rows, function($a, $b) { $a.utilization_pct < $b.utilization_pct }).{ 'db': binding_name, 'pct': utilization_pct }`,
      columns: [S('db', 'db'), N('pct', 'pct')] }), 'db', 'pct', 0, 4, 24, 5,
    { dec: 1, desc: '每個 D1 庫用了 10 GB 上限的幾成，最滿的在左；80% 起琥珀、90% 起紅（硬門檻）。成長速度與到門檻天數在 /v1/capacity。' }),
    gauges('Cloudflare 免費額度', q('plan:cloudflare-quota', { root: 'rows', columns: [S('product', 'product'), N('pct', 'pct')] }), 'product', 'pct', 0, 9, 8, 8,
      { desc: '用量 ÷ 方案含量：Workers 請求、D1 讀寫為本月，KV 讀取為今日，儲存為目前。來源規劃：Cloudflare GraphQL＋Billing（資料源 sv-cloudflare-api，token 未設）。' }),
    cost.byServiceDonut,
    cost.cumulative,
    heatmap('D1 讀取列（日 × 時）', d1Grid('r'), 0, 17, 8, 8, { fill: COOL.seq.reads, steps: 5, unit: 'short', top: true,
      desc: '一格＝一天的一個小時（台灣時間）讀取的列數，越亮越多（沒有讀取＝與背景同色）；看晚鏈 21:45–23:30 的尖峰是否變寬或變亮。來源規劃：Cloudflare GraphQL d1AnalyticsAdaptiveGroups。' }),
    heatmap('D1 寫入列（日 × 時）', d1Grid('w'), 8, 17, 8, 8, { fill: COOL.seq.writes, steps: 5, unit: 'short', top: true,
      desc: '一格＝一天的一個小時（台灣時間）寫入的列數，越亮越多。來源規劃：Cloudflare GraphQL d1AnalyticsAdaptiveGroups。' }),
    // Percentiles, not a bucket heatmap: the distribution has 103 buckets and about 22k requests in 30 days, so even daily
    // cells are 62 % empty and the 0 ms bucket alone holds 40 % of the requests (measured 2026-11-26).
    { type: 'timeseries', title: 'Cloud Run 延遲 p50／p95', gridPos: gp(16, 17, 8, 8), datasource: GCP_DS,
      description: '所有 Cloud Run 服務每 6 小時的請求延遲中位數（p50）與 p95（Cloud Monitoring distribution 合併後取百分位）；縱軸是對數。看 p95 有沒有往上長、和 p50 差距有沒有拉大。',
      targets: [gcpSeries('A', LATENCIES, null, 'ALIGN_DELTA', '+21600s', 'p50', 'REDUCE_PERCENTILE_50'),
        gcpSeries('B', LATENCIES, null, 'ALIGN_DELTA', '+21600s', 'p95', 'REDUCE_PERCENTILE_95')],
      options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } },
      fieldConfig: { defaults: { unit: 'ms', decimals: 0, noValue: NO_SOURCE, custom: { drawStyle: 'line', lineWidth: 2, fillOpacity: 0, showPoints: 'never', spanNulls: true,
        scaleDistribution: { type: 'log', log: 10 } } },
      overrides: [['A', COOL.cat[0]], ['B', COOL.cat[2]]].map(([refId, color]) => ({ matcher: { id: 'byFrameRefID', options: refId }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } },
    gcpStates('Cloud Run 服務執行個體', gcpSeries('A', INSTANCES, 'resource.label.service_name', 'ALIGN_MAX', '+3600s', '{{resource.label.service_name}}'), 0, 25, 12, 7,
      { on: '有執行個體', empty: '沒有', desc: '每個服務每小時有沒有執行個體醒著（scale-to-zero 下，藍＝那一小時有執行個體在跑）。滑鼠停在色段上看持續多久。' }),
    states('state-timeline', 'Cloud Run Job 成敗', q('plan:cloud-run-job-runs', { root: `rows.{ 'time': time, 'job': job, 'result': result }`,
      columns: [T('time', 'time'), S('job', 'job'), S('result', 'result')] }), 'job', 12, 25, 12, 7,
    { timeFrom: '14d', opts: { mergeValues: false }, desc: '每個 Job 一列，色段從一次執行開始、到下一次執行為止：綠＝成功、紅＝失敗。' }),
  ]
}

/** A job-day cell: 'ok|<text>' or 'fail|<text>'; the text (runs and minutes) is what the tooltip shows. */
const JOB_DAY_MAPPINGS = [['ok', C.ok], ['fail', C.bad]].map(([key, color], index) =>
  ({ type: 'regex', options: { pattern: `^${key}\\|(.*)$`, result: { text: '$1', color, index } } }))
/** OPB arms in the bubble chart, one query (frame) each so each keeps its colour. */
const ARMS = Object.keys(ARM_COLORS).filter((arm) => arm !== 'arm_inert')
/** A model's OOS IC against its own gate thresholds (ml-controller offline gate: FAIL at or below min_oos_ic_mean,
 * WEAK_PASS below weak_oos_ic_mean), as '<tier>|<IC to 3 places>'. Thresholds are read per row, never assumed. */
const IC_CELL = `($ic := oos_ic; $lo := min_oos_ic_mean; $weak := weak_oos_ic_mean;
  $tier := $type($ic) != 'number' ? '' : $type($lo) = 'number' and $type($weak) = 'number' ? ($ic <= $lo ? 'bad' : $ic < $weak ? 'warn' : 'ok') : 'none';
  $tier ? $tier & '|' & $string($round($ic, 3)) : null)`
const IC_TIER_MAPPINGS = [['ok', C.ok], ['warn', C.warn], ['bad', C.bad], ['none', C.idle]].map(([key, color], index) =>
  ({ type: 'regex', options: { pattern: `^${key}\\|(.*)$`, result: { text: '$1', color, index } } }))
const CLOCK_NAMES = JSON.stringify({ shadow_a: 'Shadow A', rfs_allocator: 'RFS allocator', execution_parity: 'Execution parity' })
/** v5 ④ words for internal names (Wei 11/26: no ids on the page). Gauge labels fit a 375 px phone (a third of it each). */
const CLOCK_SHORT = JSON.stringify({ shadow_a: '影子 A', rfs_allocator: 'RFS 配置', execution_parity: '執行一致' })
const ARM_NAMES = { base: '基準', diversified_alpha: '分散・alpha', diversified_all_eligible: '分散・全合格', liquidity_diversified: '流動性分散',
  conservative_diversified: '保守分散', high_score_conservative: '高分保守', arm_inert: '被風控壓成一組' }
const ARM_NAME_MAPPINGS = [{ type: 'value', options: Object.fromEntries(Object.entries(ARM_COLORS).map(([arm, color], index) => [arm, { text: ARM_NAMES[arm], color, index }])) }]
/** Cloud Run Jobs by what they do; a job not listed keeps its id. */
/** Every Cloud Run Job in prod (gcloud run jobs list, 11/26) in words; one not listed here reads 其他 Job, never its id.
 * The -min-0 / -min-1 jobs scale a service's minimum instances down to 0 or up to 1 (keep one warm). */
const JOB_NAMES = JSON.stringify({ 'pipeline-v2': '夜間 Pipeline', 'screener-v2': '選股篩選', 'verify-v2': '預測驗證', 'active8-oof-materialize': 'Active-8 證據產出',
  'dataset-snapshot-export': '研究快照匯出', 'realtime-runtime': '盤中即時執行', 'weekly-backtest-research': '每週回測研究', 'optuna-research-sweep': 'Optuna 參數搜尋',
  'l4-distribution-refresh': 'L4 分布更新', 's12-structure-batch': 'S12 結構研究', 'strategy-mining-research': '策略探勘研究',
  'ml-controller-min-0': 'Controller 縮到 0', 'ml-controller-min-1': 'Controller 保溫 1 台', 'ml-controller-monthly-min-0': '月訓 Controller 縮到 0',
  'ml-controller-monthly-min-1': '月訓 Controller 保溫 1 台', 'realtime-runtime-min-0': '盤中執行縮到 0', 'realtime-runtime-min-1': '盤中執行保溫 1 台' })
const KV_NAMES = JSON.stringify({ 'trading:config': '交易基準設定', 'trading:risk_config': '風控設定' })
/** model_artifact_registry states in words (as 最近一次月訓結果 shows them). */
const REGISTRY_WORDS = JSON.stringify({ production: '上線', approved: '已核准', archived: '已封存', shadowing: '影子中', approval_required: '待核准',
  rejected: '被拒', offline_failed: '離線未過', registration_failed: '註冊失敗' })
/** The offline gates a model can fail (model_artifact_registry.py evaluate_offline_gate); another name reads 其他閘門. */
const GATE_WORDS = JSON.stringify({ artifact_registration_failed: '註冊失敗', model_cpcv_failed: 'CPCV 未過', oos_ic_below_policy_floor: 'OOS IC 低於門檻' })

/** 模型名冊／最近一次月訓結果 on a 375 px phone (331 px inside) and at 1440: the short columns get fixed widths that hold
 * their header with its sort arrow (閘門 66, IC 51, the last column 78 px: headerPx) and their longest value (強通過,
 * -0.123, 未上線), and 模型 takes the rest, 119 px on a phone, which holds the longest model name. Floors alone do not
 * work: Grafana gives every auto column the same share (computeColWidths) or its content width, so 4 floors on a phone
 * either cut 模型 at 83 px or overflow (413 px measured with the 11/26 floors). */
const SHORT_TABLE = (last) => {
  const wd = { 閘門: 70, IC: 64, [last]: 78 }
  fitColumn('模型表', '閘門', Object.values(GATE_VOCAB).map(([word]) => word), wd.閘門)
  fitColumn('模型表', 'IC', ['-0.123'], wd.IC)
  fitColumn('模型表', last, ['未上線', '已核准', '已封存', '上線中'], wd[last], true)
  fitColumn('模型表', '模型', ['iTransformer', 'ExtraTrees', 'LightGBM', 'PatchTST', 'TimeXer'], PHONE_W - Object.values(wd).reduce((a, b) => a + b, 0), true)
  return { wd, mw: { 模型: 50 } }
}

function model5(q) {
  const v4 = model(q)
  const [ret, excess, drawdown, opb, models, nav, armDays] = v4
  const kv = v4.find((panel) => panel.title === 'KV 設定漂移（7 天）')
  const roster = table('模型名冊', q(ROSTER, { root: `rows.{ 'model': model_name, 'gate': gate_decision, 'ic': ${IC_CELL},
      'state': ($w := $lookup(${REGISTRY_WORDS}, state); $w ? $w : state ? state : '—'),
      'min': 'IC 門檻 ' & $string(min_oos_ic_mean) & '（弱 ' & $string(weak_oos_ic_mean) & '，強 ' & $string(strong_oos_ic_mean) & '）', 'version': '版本 ' & champion_version,
      'run': source_run_date ? '訓練資料 ' & source_run_date : '訓練資料 —' }`,
    columns: [S('model', '模型'), S('gate', '閘門'), S('ic', 'IC'), S('state', '狀態'), S('min', 'IC 門檻'), S('version', '版本'), S('run', '訓練')] }),
    0, 14, 14, 7, { status: ['閘門'], vocabulary: GATE_VOCAB, ...SHORT_TABLE('狀態'), hidden: ['IC 門檻', '版本', '訓練'], details: { 模型: ['IC 門檻', '版本', '訓練'] },
      desc: '上線中的 alpha roster 與各模型最近一次月訓的離線閘門。IC＝OOS IC，格子照該模型自己的閘門門檻上色：紅＝不高於 min 門檻（未過），'
        + '琥珀＝低於弱門檻（弱通過），綠＝達弱門檻以上；灰＝沒有門檻。狀態＝registry 狀態（上線＝production）。點模型名稱看門檻、版本與訓練資料日。' })
  // A cell filled with its tier's colour (the number is the magnitude), as the solid cells are.
  roster.fieldConfig.overrides.push({ matcher: { id: 'byName', options: 'IC' }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'mappings', value: IC_TIER_MAPPINGS }] })
  // One bar per arm with a mean reward, in the arms' order; an arm without one (a new context: 0 samples) is no bar.
  const opbBars = q(OPB, { columns: [S('name', 'name'), N('reward', '平均 reward'), S('arm', 'arm')],
    root: `($names := ${JSON.stringify(ARM_NAMES)}; $order := ${JSON.stringify(ARMS)}; $stats := latest_arm_statistics[$type(mean) = 'number']; $share := arm_share;
      $out := $order.($id := $; $st := $stats[arm_id = $id][0]; $s := $share[arm_id = $id][0].share;
        $st ? { 'name': $lookup($names, $id) & '｜' & $string($st.samples) & ' 樣本｜選用 ' & $string($round(($s ? $s : 0) * 100)) & '%', 'reward': $st.mean, 'arm': $id });
      $count($out) > 0 ? $out : [])` })
  // The KV keys in words (the row names); the root binds each key as $k (see model()).
  for (const target of kv.targets) target.root_selector = target.root_selector.replace("'key': $k,", `'key': $lookup(${KV_NAMES}, $k),`)
  if (!kv.targets[0].root_selector.includes(KV_NAMES)) throw new Error('KV 設定漂移: key names not applied')
  armDays.fieldConfig.defaults.mappings = ARM_NAME_MAPPINGS
  // 一致 is not an event, so it is a calm cool tone; 漂移 (amber) and 缺少／無效 (red) are what to look at.
  kv.fieldConfig.defaults.mappings = [{ type: 'value', options: { match: { text: '一致', color: COOL.calm, index: 0 },
    drift: { text: '漂移', color: C.warn, index: 1 }, missing: { text: '缺少', color: C.bad, index: 2 }, invalid: { text: '無效', color: C.bad, index: 3 } } }]
  return [
    ret, excess, drawdown, opb, models,
    Object.assign(nav, { gridPos: gp(0, 4, 14, 6) }),
    { type: 'timeseries', title: '回撤', gridPos: gp(0, 10, 14, 4), description: 'Paper NAV 離窗口內最高點的距離（underwater）；越深＝回撤越大。',
      targets: [q(NAV, { root: `rows.{ 'time': ${DAY_TIME('date')}, 'dd': drawdown_pct }`, columns: [T('time', 'time'), N('dd', '回撤')] })],
      options: { legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'single' } },
      // A loss, not an alert: a muted red, lightly filled.
      fieldConfig: { defaults: { unit: 'percent', decimals: 1, max: 0, noValue: NO_SOURCE, color: { mode: 'fixed', fixedColor: COOL.loss },
        custom: { drawStyle: 'line', lineWidth: 1, fillOpacity: 18, gradientMode: 'opacity', showPoints: 'never', spanNulls: true } }, overrides: [] } },
    // The bubble chart's legend names the arms in the same colours; here a legend would not fit in four rows.
    Object.assign(armDays, { gridPos: gp(14, 4, 10, 4), options: { ...armDays.options, legend: { ...armDays.options.legend, showLegend: false } },
      description: `${armDays.description}顏色與右下 OPB arm 長條相同。` }),
    // Bars, not the xychart bubbles: Grafana's xychart passes PanelDataErrorView its own "No data" warning, so its noValue never
    // shows; a barchart with no rows shows noValue centred (a new context: every arm has 0 samples and no mean reward).
    hbars('OPB arm：樣本數 × 平均 reward', opbBars, 'name', 14, 8, 10, 6, { unit: 'percentunit', dec: 2, colorBy: 'arm', labelMax: 20,
      empty: '目前 context 還沒有 reward 樣本',
      overrides: [{ matcher: { id: 'byName', options: 'arm' }, properties: [{ id: 'mappings', value: ARM_NAME_MAPPINGS }, { id: 'custom.hideFrom', value: { legend: true, tooltip: true, viz: false } }] }],
      desc: '一條＝一個 arm：長度＝平均 reward（往右＝正、往左＝負），名稱後＝累積樣本數與近 60 天被選用的比例，顏色同左邊「每天選到的 OPB arm」。'
        + '有在學的話，樣本多、選用比例高的 arm 會是 reward 較高的那幾條；每條都差不多長＝沒有在分辨 arm。'
        + '樣本與 reward 取最新一筆有 arm 統計的計畫（所有 arm 被壓成同一組的那天不存統計）；換 context 後各 arm 還沒有 reward 時不畫，顯示「目前 context 還沒有 reward 樣本」。' }),
    roster,
    // One cell per job and day (status-history): a run of minutes is invisible as a state-timeline segment over 14 days.
    // A state timeline, not a status history: the status history labels every sample on its time axis, so 14 dates overlap
    // (11/1511/16…); the timeline keeps Grafana's own tick spacing. Every job × day is a cell (none: no run that day),
    // so a day without a run does not carry the previous day's colour.
    states('state-timeline', '訓練與研究 Job（每天）', q('plan:cloud-run-job-days', { root: `($days := $sort($distinct(rows.time)); $distinct(rows.job).($j := $;
        $n := $lookup(${JOB_NAMES}, $j); $days.($d := $; $c := $$.rows[job = $j and time = $d][0].cell; { 'time': $d, 'job': $n ? $n : '其他 Job', 'cell': $c ? $c : 'none|沒跑' })))`,
      columns: [T('time', 'time'), S('job', 'job'), S('cell', 'cell')] }), 'job', 14, 14, 10, 7,
    { timeFrom: '14d', empty: '14 天內沒有執行', mappings: [...JOB_DAY_MAPPINGS, { type: 'regex', options: { pattern: '^none\\|(.*)$', result: { text: '$1', color: C.dim, index: 2 } } }],
      opts: { mergeValues: false, rowHeight: 0.8 },
      desc: '每個 Cloud Run Job 一列、每天一格：綠＝當天的執行都成功，紅＝當天有失敗，空白＝當天沒跑。滑鼠停在格子上看當天跑了幾次、共幾分鐘。'
        + '尚未接資料：每個 Job 每天的成敗要監控 Worker 新增一條 route（資料來源待查），目前畫的是示範資料。' }),
    Object.assign(kv, { gridPos: gp(0, 21, 12, 4) }),
    gauges('證據累積（距 20 日門檻）', q(CLOCKS, { root: `rows.{ 'name': $lookup(${CLOCK_SHORT}, mechanism), 'days': distinct_dates }`,
      columns: [S('name', 'name'), N('days', 'days')] }), 'name', 'days', 12, 21, 12, 4,
    { unit: 'suffix: 日', max: 20, th: th([C.run, null], [C.ok, 20]),
      desc: '各影子機制已累積的證據日數，滿 20 日轉綠（可以下判斷）。影子 A＝Shadow A；RFS 配置＝RFS allocator；執行一致＝Execution parity，要有真實下單才會開始累積。'
        + 'RFS allocator 的證據日數、被擋的收據與滿 20 日的日數要等 RFS 比較表加上 D1 索引後 Worker 才提供（目前固定回 0／null），所以這一格先停在 0。' }),
  ]
}
/* ---- v6 preview (11/26 Wei: 今天頁朝圖表多樣性與配色): each panel the chart its question asks for; a normal state is a
 * muted teal instead of no colour, anomalies keep the saturated amber / red. ---- */

/** Muted teal for a normal value or a finished stage: visible, but quieter than amber and red (white text 6.3:1). */
const CALM_OK = '#1d6b73'
/** A background stat's "nothing to show" value: −1 from the selector, drawn as words in a stated colour. A null would
 * take the lowest threshold step and read as normal (or amber) when there is no data. */
const NONE = -1
const noneMapping = (text, color) => [{ type: 'value', options: { [NONE]: { text, color, index: 0 } } }]
const orNone = (expr) => `($v := ${expr}; $type($v) = 'number' ? $v : ${NONE})`
const DONE_DARK = '#173d42'
/** Chain states on the v6 timeline: waiting grey, running blue, failed red; done is a dark teal, because a state lasts
 * until the next transition and a finished stage's band runs on to now: the running (blue) stretch is the duration. */
const TIMELINE_MAPPINGS = [{ type: 'value', options: Object.fromEntries(Object.entries({
  pending: ['未開始', C.dim], waiting: ['等待中', C.idle], running: ['執行中', C.run], success: ['完成', DONE_DARK], retry_success: ['重試後完成', DONE_DARK],
  skipped: ['略過', C.skip], error: ['失敗', C.bad], blocked: ['中止', C.bad] }).map(([key, [text, color]], index) => [key, { text, color, index }])) }]
/** Minutes a history row took: to completed_at, or to the response's generated_at while it still runs. */
const DURATION = `$mins := function($r, $now) { (($r.completed_at ? $toMillis($r.completed_at) : $now) - $toMillis($r.started_at)) / ${MIN_MS} }`
const MEDIAN = `$median := function($v) { ($s := $sort($v); $c := $count($s); $c = 0 ? null : $c % 2 = 1 ? $s[$floor($c / 2)] : ($s[$c / 2 - 1] + $s[$c / 2]) / 2) }`
/** A stage's usual duration: the median of its successful runs on other business dates in the 14-day history (at least 3),
 * else 0 (Infinity's JSONata cannot compare null, so `$u >= 1` must see a number). */
const USUAL = `$usual := function($id, $day) { ($v := $all[stage_id = $id and business_date != $day and status = 'success' and started_at and completed_at].$mins($, 0);
  $count($v) >= 3 ? $median($v) : 0) }`
/** Duration ÷ usual: the usual band (0.8–1.2×) is CALM_OK, faster the deep blue, slower the grey blue, from 1.5× amber. Red is
 * for failures only (Wei 11/26): a stage twice as slow as usual is still a warning. */
const RATIO_TH = th([COOL.margin[2], null], [CALM_OK, 0.8], [COOL.margin[0], 1.2], [C.warn, 1.5])
/** Too few other business days for a usual duration: both ratio panels say it in these words. */
const RATIO_EMPTY = '樣本不足：需 3 個其他業務日'
/** A row that only carries the frame's field types through an empty result; DROP_NO_ROWS removes it before drawing. */
const NO_ROWS = '__no_rows__'
const DROP_NO_ROWS = (field) => ({ id: 'filterByValue', options: { type: 'exclude', match: 'any',
  filters: [{ fieldName: field, config: { id: 'equal', options: { value: NO_ROWS } } }] } })
const RATIO_DESC = '耗時倍數＝這一站這天的耗時 ÷ 近 14 天其他業務日成功時的中位數耗時（至少 3 個其他業務日的紀錄才算；流程鏈狀態表 11/25 起寫入，之前顯示「樣本不足」）。'
  + '深藍＝比平常快（< 0.8×）、暗青＝平常（0.8–1.2×）、灰藍＝偏慢（1.2–1.5×）、琥珀＝慢一半以上（≥ 1.5×）。耗時不到 1 分鐘的站不列。'

function today6(q) {
  const [progress, , chain, todo, readiness] = today(q)
  const stageName = `($n := $lookup(${SLACK_NAMES}, stage_id); $n ? $n : $lookup(${NAMES}, stage_id))`
  // Tonight's duration ratio per stage: running stages count up to now, so a stage that is already slow shows before it ends.
  const ratios = q(HISTORY, { root: `(${DURATION}; ${MEDIAN}; $all := rows; $day := business_date; $now := $toMillis(generated_at); ${USUAL};
    $r := $all[business_date = $day and started_at and status in ['running', 'success', 'error']].($u := $usual(stage_id, $day); $m := $mins($, $now);
      $u >= 1 ? { 'stage': ${stageName} & '｜' & $string($round($m)) & 'm', 'ratio': $round($m / $u, 2) });
    $r ? $sort($r, function($a, $b) { $a.ratio < $b.ratio }) : [])`, columns: [S('stage', 'stage'), N('ratio', '倍數')] })
  // Bars, not a bar gauge: too few days is the centred message, not a grey bar with the words at its end (Wei 11/26).
  const slow = hbars('今晚各站耗時 ÷ 平常（最慢在上）', ratios, 'stage', 15, 22, 9, 14, { unit: 'suffix:×', dec: 1, th: RATIO_TH, softMin: 0, softMax: 3,
    labelMax: 22, empty: RATIO_EMPTY, desc: `${RATIO_DESC}執行中的站算到現在，所以還沒跑完就能看出變慢。名稱後＝今晚已用分鐘。` })
  const timeline = states('state-timeline', '最近兩晚各站時間軸', q('/v1/chain/timeline?days=2', { root: `${byChainOrder('rows', 'transition_at')}.{
      'time': transition_at, 'stage': ${stageName}, 'status': to_status }`, columns: [T('time', 'time'), S('stage', 'stage'), S('status', 'status')] }),
  'stage', 0, 22, 15, 14, { mappings: TIMELINE_MAPPINGS, legend: true, timeFrom: '36h', opts: { rowHeight: 0.8, mergeValues: true },
    desc: '最近兩個業務日每一站的狀態變化（前一晚完整、今晚進行中），一列一站（順序同流程鏈）：藍＝執行中（藍色那段的長度＝耗時）、深青＝已完成（延續到下一次狀態變化）、紅＝失敗或中止、灰＝未開始。滑鼠停在色帶上看起訖。' })
  // Background-coloured numbers: muted teal when nothing needs doing, amber / red when something does.
  const bg = (panel) => Object.assign(panel, { options: { ...panel.options, colorMode: 'background', graphMode: 'none' } })
  const tail = spark('L3 收尾', q(HISTORY, { root: `rows[stage_id = 'pipeline' and status = 'success' and completed_at].{ 'time': time,
    'tail': ${CLOCK_BASE} + $toMillis(completed_at) - $toMillis(time) }`, columns: [T('time', 'time'), N('tail', '完成時間')] }), 4, 0, 4, 4,
  { unit: 'time:HH:mm', timeFrom: '14d', th: th([C.txt, null], [C.warn, CLOCK_BASE + (PIPELINE_DEADLINE - 15) * MIN_MS]),
    desc: '最近一晚 L3 Pipeline 全部完成的時間（隔天早上）；折線＝近 14 天每晚，往上＝越跑越晚。截止前 15 分起轉琥珀（晚到不算失敗，所以不轉紅）。' })
  const failed = spark('失敗站次', q(HISTORY, { root: perDate(`$count($r[${FAILED}])`), columns: [T('time', 'time'), N('v', '失敗站次')] }), 8, 0, 4, 4,
    { timeFrom: '14d', th: th([C.txt, null], [C.warn, 1], [C.bad, 3]), desc: '每晚失敗或中止的站數（14 日）：數字＝這個業務日，折線＝近 14 天每天。' })
  const counts = bg(kpi('現在', [
    // Red only when a failure is among them (failed, stuck, missed: the critical kinds); warnings alone are amber.
    q(ALERTS, { root: `($b := counts.failed + counts.stuck + counts.missed; { 'k': 1,
      'todo': ($b > 0 ? 'bad|' : counts.total > 0 ? 'warn|' : 'ok|') & $string(counts.total) })`, columns: [KPI_KEY, S('todo', '要處理')], refId: 'A' }),
    q(READINESS, { root: `($all := $append(rows, checks[id != 'market_dashboard_materialization']); { 'k': 1,
      'late': $count($all[status in ['waiting', 'warn', 'blocked', 'fail']]) })`, columns: [KPI_KEY, N('late', '資料遲到／缺漏')], refId: 'B' }),
    // No pending deadline is NONE (−1), not null: a null value takes the base step (amber) on a background stat.
    q(STATE, { root: `($now := $toMillis(generated_at); $m := $min(rows[active = true and optional = false and sub_stage != true and $not(completed_at)
      and expected_by != null].(($toMillis(expected_by) - $now) / 60000)[$ >= 0]); { 'k': 1, 'next': $type($m) = 'number' ? $m : ${NONE} })`,
    columns: [KPI_KEY, N('next', '下一個截止')], refId: 'C' }),
  ], 12, 0, 8, 4, [{ name: '要處理', mappings: TONE6 }, { name: '資料遲到／缺漏', th: th([CALM_OK, null], [C.warn, 1]) },
    { name: '下一個截止', unit: 'm', th: th([C.warn, null], [CALM_OK, 15]), mappings: noneMapping('今晚無待截止', CALM_OK) }]))
  counts.description = '要處理＝四條鏈的失敗、逾時、卡住、漏跑，和過了 09:10 仍被擋住的盤中監控；其中有失敗、卡住或漏跑時紅底，只有逾時、被擋住時琥珀底；資料遲到／缺漏＝已過寫入期限還沒到的資料集；下一個截止＝還沒完成的必要階段裡最近的截止還剩幾分鐘（沒有待截止的階段＝今晚無待截止）。都正常時是青色底。'
  Object.assign(progress, { gridPos: gp(0, 0, 4, 4) })
  progress.fieldConfig.defaults.thresholds = th([C.run, null])
  Object.assign(chain, { gridPos: gp(0, 4, 24, 18) })
  // 要處理 needs its fixed columns (TODO_WIDTHS, 278 px) and a stage name: at 1440 px with Grafana's menu docked the grid is
  // about 1,010 px, so 8 units (332 px) scrolled sideways and 10 (413 px) fit. The readiness cards are laid out for their own width.
  Object.assign(todo, { gridPos: gp(0, 36, 10, 8) })
  const cards = readinessCanvas(readiness.title, readiness.targets[0], READINESS_SLOTS, 10, 36, 14, 8, { cols: Math.ceil(READINESS_SLOTS / 2), desc: readiness.description })
  return [progress, ...tail, ...failed, counts, d1Overloaded(q, 20, 0, 4, 2), guardCell(q, 20, 2, 4, 2), chain, timeline, slow, todo, cards]
}

/** v6 ②: the deadline-margin grid becomes duration ÷ usual (Wei 11/26: 餘裕看不出資訊), same rows and cells. */
function health6(q) {
  const panels = health5(q)
  const at = panels.findIndex((panel) => panel.title?.startsWith('距截止的餘裕'))
  const old = panels[at]
  // Infinity serves an empty result as a frame without fields, which the status history reports as "Data does not have a
  // time field" instead of its noValue; too few days is one row named by the message over the window, as 出過狀況的站 does.
  const ratio = grid('耗時倍數（÷ 平常）', q(HISTORY, { root: `(${DURATION}; ${MEDIAN}; $all := rows; ${USUAL};
    $out := ${byChainOrder(SLACK_ROWS, 'time')}.($u := $usual(stage_id, business_date); $u >= 1 ? { 'time': time,
      'stage': ($n := $lookup(${SLACK_NAMES}, stage_id); $n ? $n : label), 'ratio': $round($mins($, 0) / $u, 2) });
    $count($out) > 0 ? $out : { 'time': ${DAY_TIME('from')}, 'stage': '${NO_ROWS}' })`,
  columns: [T('time', 'time'), S('stage', 'stage'), N('ratio', '倍數')] }), old.gridPos.x, old.gridPos.y, old.gridPos.w, old.gridPos.h,
  { unit: 'suffix:×', dec: 1, th: RATIO_TH, empty: RATIO_EMPTY, desc: `一列＝一個必要階段，一格＝一個業務日。${RATIO_DESC}同一列越往右越暖色＝這一站越跑越慢。只算成功完成的必要階段；失敗、略過、還沒完成的格子是空的。` })
  // Too few days: the root's one NO_ROWS row (Infinity turns an empty result into a frame without fields, which the
  // status history reports as "Data does not have a time field") is filtered out here, leaving a typed frame with no rows;
  // partitioning that yields no frames, and the status history then shows noValue centred.
  ratio.transformations.push(DROP_NO_ROWS('stage'))
  ratio.transformations.push({ id: 'partitionByValues', options: { fields: ['stage'], keepFields: false, naming: { asLabels: true } } })
  ratio.fieldConfig.defaults.displayName = '${__field.labels.stage}'
  panels[at] = ratio
  // Late is not a failure (Wei 11/26: red is for failures only): past the deadline amber, the 15 minutes before a light amber.
  const tail = panels.find((panel) => panel.title === 'L3 Pipeline 收尾時間')
  tail.fieldConfig.defaults.thresholds.steps = tail.fieldConfig.defaults.thresholds.steps.map((step) =>
    ({ ...step, color: step.color === C.bad ? C.warn : step.color === C.warn ? TONE.warn.text : step.color }))
  tail.description = tail.description.replace('紅區＝超過截止、琥珀＝截止前 15 分內。', '琥珀區＝超過截止、淡琥珀＝截止前 15 分內（晚到不算失敗，所以不用紅）。')
  return panels
}

/* ---- v6 ④ and ① additions (11/26 Wei: 研究資料新鮮度 folded into ④ and ①, no new dashboard; worker/src/monitoring/modelOps.ts). ---- */
const SEAL = '/v1/policy/seal'
const LEDGER = '/v1/opb/ledger'
const SERVING = '/v1/models/serving'
const GUARD = '/v1/serving-guard'
const D1_OVERLOADED = '/v1/d1/overloaded'
/** Worker routes this checkout serves that prod does not yet: preview6live draws them over mock.mjs (示範資料).
 * Remove a path once the monitoring Worker that serves it is deployed. */
const NOT_DEPLOYED = new Set([SEAL, LEDGER, SERVING, GUARD, D1_OVERLOADED])
/** '<tone>|<text>' cells: the tone picks the colour, the text is what the cell or tooltip shows. */
const toneMappings = (pairs) => pairs.map(([key, color], index) => ({ type: 'regex', options: { pattern: `^${key}\\|(.*)$`, result: { text: '$1', color, index } } }))
const TONE6 = toneMappings([['ok', CALM_OK], ['info', COOL.cat[1]], ['wait', C.idle], ['na', C.idle], ['warn', C.warn], ['bad', C.bad]])
/** A field that is a quantity, not a judgment: the quiet steel blue, so a background stat never shows a white tile. */
const NEUTRAL = th([COOL.calm, null])
function bgKpi(title, targets, x, y, w, h, fields, desc, textMode = 'value_and_name') {
  const panel = kpi(title, targets, x, y, w, h, fields)
  panel.options = { ...panel.options, colorMode: 'background', graphMode: 'none', textMode }
  panel.description = desc
  return panel
}
/** The T+5 serving guard as one cell (expected_return_serving_forward_guard.py: 3 jointly inferior dates bypass, 3 passing recover). */
const GUARD_CELL = `($s := summary.status; $s = 'not_applicable' ? 'na|未啟用' : $s = 'mismatch' ? 'bad|版本不符' : $s = 'bypass' ? 'bad|已旁路・恢復 ' & $string(summary.recovery_streak) & '／' & $string(thresholds.pass_streak_to_recover)
  : $s = 'warning' ? 'warn|惡化 ' & $string(summary.degraded_streak) & '／' & $string(thresholds.degraded_streak_to_bypass) & ' 日' : 'ok|正常')`
const GUARD_DESC = 'Fusion artifact 上線後的 T+5 前向檢查：連續 3 個預測日 IC 與價差都輸 L4 就旁路 residual，旁路後要連續 3 日通過才恢復（至少 5 個可評估日）。'
  + '未啟用＝目前沒有 Fusion residual 在服務，不需要這道保護（灰）；正常＝青；惡化中＝琥珀；已旁路＝紅；'
  + '版本不符＝guard 綁的 artifact／fingerprint 不是目前服務中的 Fusion（紅，日數不顯示）。'
function guardCell(q, x, y, w, h) {
  return bgKpi('T+5 guard', [q(GUARD, { root: `{ 'g': ${GUARD_CELL} }`, columns: [S('g', 'guard')] })], x, y, w, h,
    [{ name: 'guard', mappings: TONE6 }], GUARD_DESC, 'value')
}
function d1Overloaded(q, x, y, w, h) {
  return bgKpi('D1 過載', [q(D1_OVERLOADED, { root: `{ 'n': summary.count }`, columns: [N('n', '次數')] })], x, y, w, h,
    [{ name: '次數', th: th([CALM_OK, null], [C.warn, 1], [C.bad, 5]) }],
    'D1 overloaded（24 小時）：近 24 小時以 D1 overloaded（或 Requests queued for too long）結束的排程 ticket 數（讀排程執行紀錄的最後錯誤與摘要，不另外寫 D1）。'
    + '任務內部重試後成功的不算。0＝青、≥1 琥珀、≥5 紅。', 'value')
}
const GATE6 = [{ type: 'value', options: Object.fromEntries(Object.entries({ STRONG_PASS: ['強通過', CALM_OK], PASS: ['通過', CALM_OK], WEAK_PASS: ['弱通過', C.warn],
  FAIL: ['未過', C.bad], PENDING: ['待定', C.idle] }).map(([key, [text, color]], index) => [key, { text, color, index }])) }]
const REGISTRY_STATE6 = [{ type: 'value', options: Object.fromEntries(Object.entries({ production: ['上線', C.txt], approved: ['已核准', C.txt], archived: ['已封存', C.sub],
  shadowing: ['影子中', C.txt], approval_required: ['待核准', C.warn], rejected: ['被拒', C.bad], offline_failed: ['離線未過', C.bad],
  registration_failed: ['註冊失敗', C.bad] }).map(([key, [text, color]], index) => [key, { text, color, index }])) }]
const IC_TIER6 = toneMappings([['ok', CALM_OK], ['warn', C.warn], ['bad', C.bad], ['none', C.idle]])

/** ④ v6: model5 moved down one strip; the strip answers is OPB learning, is today's plan sealed, is the serving guard
 * holding; the bottom row is each model's serving days and the latest monthly retrain. */
function model6(q) {
  const panels = model5(q).flat()
  for (const panel of panels) panel.gridPos = { ...panel.gridPos, y: panel.gridPos.y + 4 }
  const ledger = bgKpi('OPB reward 帳本落後', [q(LEDGER, { root: `{ 'lag': ${orNone('summary.lag_trading_days')}, 'ctx': summary.current_context_rows }`,
    columns: [N('lag', '落後交易日'), N('ctx', '目前 context 樣本')] })], 0, 0, 6, 4,
  [{ name: '落後交易日', th: th([CALM_OK, null], [C.warn, 2]), mappings: noneMapping('帳本無資料', C.warn) },
    { name: '目前 context 樣本', th: th([C.warn, null], [CALM_OK, 1]) }],
  'OPB v2 只從 arm replay 帳本學。落後交易日＝帳本最新的 reward 可知日距「最近一次盤後收尾能補到的日期」（收尾日的前一個交易日）幾個交易日：'
    + '0＝即時、≥2 琥珀（最多算到 20；落後不是失敗，所以不轉紅）；帳本沒有任何 replay 或算不出參考日＝「帳本無資料」（琥珀）。目前 context 樣本＝最新計畫的 context 已有幾筆 replay；0＝這個 context 還沒學到東西（換 L3 版本或風控設定會換 context，要等 5 個交易日後才有第一筆）。')
  const seal = bgKpi('今日正式政策', [q(SEAL, { root: `{ 'today': ($s := summary.today_status; $s = 'sealed' ? 'ok|已封存' : $s = 'waiting' ? 'wait|等待中'
      : $s = 'missing' ? 'bad|未封存' : 'na|休市'), 'at': summary.today_sealed_at ? $fromMillis($toMillis(summary.today_sealed_at), '[H01]:[m01]', '+0800') : '—',
      'miss': summary.missing_days }`, columns: [S('today', '今日'), S('at', '封存時間'), N('miss', '14 日未封存')] })], 6, 0, 6, 4,
  [{ name: '今日', mappings: TONE6 }, { name: '封存時間', th: NEUTRAL }, { name: '14 日未封存', th: th([CALM_OK, null], [C.warn, 1], [C.bad, 3]) }],
  '今天的正式計畫有沒有在盤前 08:45 cutoff 前封存：已封存＝青、cutoff 前還沒有＝灰（等待中）、過了 cutoff 還沒有＝紅；休市日不算。'
    + '14 日未封存＝近 14 天的交易日裡沒封存的天數。')
  const guard = bgKpi('serving guard（T+5）', [q(GUARD, { root: `{ 'g': ${GUARD_CELL}, 'd': ${orNone('summary.degraded_streak')},
      'r': ${orNone('summary.recovery_streak')}, 'n': ${orNone('summary.evaluable_date_count')} }`, columns: [S('g', '狀態'), N('d', '連續惡化'), N('r', '連續恢復'), N('n', '可評估日')] })], 12, 0, 6, 4,
  [{ name: '狀態', mappings: TONE6 }, ...[['連續惡化', th([CALM_OK, null], [C.warn, 1], [C.bad, 3])], ['連續恢復', NEUTRAL], ['可評估日', NEUTRAL]]
    .map(([name, steps]) => ({ name, th: steps, mappings: noneMapping('—', C.idle) }))],
  `${GUARD_DESC}連續惡化／恢復＝最近連續幾個預測日。`)
  // A state timeline (see 訓練與研究 Job): one cell per trading day, Grafana's own date ticks.
  const sealDays = states('state-timeline', '封存紀錄（14 日）', q(SEAL, { root: `rows.{ 'time': ${DAY_TIME('date')}, 'row': '封存',
      'cell': status = 'sealed' ? 'ok|' & $fromMillis($toMillis(sealed_at), '[H01]:[m01]', '+0800') & ' 封存' : status = 'waiting' ? 'wait|等待中' : 'bad|未封存' }`,
  columns: [T('time', 'time'), S('row', 'row'), S('cell', 'cell')] }), 'row', 18, 0, 6, 4,
  { mappings: TONE6, timeFrom: '14d', opts: { mergeValues: false, rowHeight: 0.8 }, empty: '14 天內沒有交易日', desc: '每個交易日一格：青＝盤前已封存（滑鼠停在格子上看封存時間）、紅＝過了 cutoff 沒有封存、灰＝今天還在 cutoff 前。' })
  const serving = states('state-timeline', '模型服務狀態（14 日）', q(SERVING, { root: `rows.{ 'time': ${DAY_TIME('date')}, 'model': model_name,
      'cell': (state = 'serving' ? 'ok|' : state = 'switched' ? 'info|換版 ' : state = 'pending' ? 'wait|待今晚 ' : 'bad|缺 ') & (version ? version : '') }`,
  columns: [T('time', 'time'), S('model', 'model'), S('cell', 'cell')] }), 'model', 0, 29, 14, 7,
  { mappings: TONE6, timeFrom: '14d', opts: { mergeValues: true, rowHeight: 0.8 }, empty: '沒有已發布的模型',
    desc: '上線 roster 的每個模型一列、每個交易日一段：青＝當天有預測（predictions 有該模型該日的列）、藍＝當天換了 champion 版本、'
      + '紅＝那天的夜間流程已結束卻沒有預測、灰＝今晚的流程還沒跑完。滑鼠停在色帶上看版本。' })
  const retrain = table('最近一次月訓結果', q(ROSTER, { root: `($run := latest_monthly_run; $run.models.{ 'model': model_name, 'gate': gate_decision, 'ic': ${IC_CELL},
      'failed': $type(failed_gates) = 'array' and $count(failed_gates) > 0 ? $join([failed_gates.($w := $lookup(${GATE_WORDS}, $); $w ? $w : '其他閘門')], '、') : '—',
      'state': ($w := $lookup(${REGISTRY_WORDS}, state); $w ? $w : state ? state : '—'), 'live': $run.is_live ? '上線中' : '未上線',
      'run': $run.source_run_date ? '訓練資料 ' & $run.source_run_date : '訓練資料 —', 'version': '版本 ' & version })`,
  columns: [S('model', '模型'), S('gate', '閘門'), S('ic', 'IC'), S('failed', '未過的閘門'), S('state', '狀態'), S('live', '上線'), S('run', '訓練'), S('version', '版本')] }),
  // Phone width (375 px): model, gate, IC and 上線 fit; the failed gates and the registry state open from the model name.
  14, 29, 10, 7, { ...SHORT_TABLE('上線'), hidden: ['未過的閘門', '狀態', '訓練', '版本'], details: { 模型: ['未過的閘門', '狀態', '訓練', '版本'] }, empty: '近 62 天沒有月訓 run',
    desc: '最近一次月訓（模型登錄表近 62 天最新的一次正式月訓）每個模型的離線閘門：閘門 青＝通過、琥珀＝弱通過、紅＝未過；'
      + 'IC＝OOS IC，照該模型自己的門檻上色；上線＝這個 run 是不是目前 ensemble 的 run。點模型名稱看未過的閘門（被拒原因）、registry 狀態、訓練資料日與版本。' })
  retrain.fieldConfig.overrides.push(
    { matcher: { id: 'byName', options: '閘門' }, properties: [{ id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'mappings', value: GATE6 }] },
    { matcher: { id: 'byName', options: 'IC' }, properties: [{ id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'mappings', value: IC_TIER6 }] },
    { matcher: { id: 'byName', options: '狀態' }, properties: [{ id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: REGISTRY_STATE6 }] })
  return [ledger, seal, guard, sealDays, ...panels, serving, retrain]
}

const V5 = { 'sv-today': today5, 'sv-health': health5, 'sv-resources': resources5, 'sv-model': model5 }

/** Header buttons on every desktop page: the four pages, then the phone page. */
const PAGE_LINKS = [['① 今天', 'sv-today'], ['② 執行品質', 'sv-health'], ['③ 資源與成本', 'sv-resources'], ['④ 策略與模型', 'sv-model'], ['手機版', 'sv-mobile']]
/** Live header links to a page not in the StockVision folder yet go to the page that holds that content today:
 * ③ 資源與成本 (sv-resources) is still sv-gcp-runtime until its v5 page is published. */
const LIVE_LINK_UIDS = { 'sv-resources': 'sv-gcp-runtime' }
const PAGES = [
  // Published to the StockVision folder on 11/26 (Wei go): the v5 page under the folder's own title.
  { uid: 'sv-today', title: 'StockVision 今天', build: today5, live: { from: 'now-24h', to: 'now' }, hours: 24, refresh: '1m', links: PAGE_LINKS },
  { uid: 'sv-health', title: 'StockVision ② 執行品質', build: health, live: { from: 'now-14d', to: 'now' }, hours: 14 * 24, refresh: '5m', links: PAGE_LINKS },
  { uid: 'sv-resources', title: 'StockVision ③ 資源與成本', build: resources, live: { from: 'now-30d', to: 'now' }, hours: 30 * 24, refresh: '15m', links: PAGE_LINKS },
  { uid: 'sv-model', title: 'StockVision ④ 策略與模型', build: model, live: { from: 'now-90d', to: 'now' }, hours: 90 * 24, refresh: '15m', links: PAGE_LINKS },
  { uid: 'sv-mobile', title: 'SV 手機', build: mobile, live: { from: 'now-24h', to: 'now' }, hours: 24, refresh: '1m', links: [['看完整版', 'sv-today']] },
]

/** Preview: routes whose live answer is already complete read the monitoring Worker. The rest read the fixtures moved to
 * the build day: history the Worker has not accumulated yet (P2 rows start 11/25), the other three chains (the deployed
 * Worker ignores `chain=` until #282), routes not deployed, billing and Cloudflare. */
// TIMELINE: the usual run times behind ①'s slow tags on the chain (v5 ② does not read it).
const PREVIEW_LIVE = new Set([STATE, ALERTS, READINESS, CAPACITY, CLOCKS, TIMELINE, '/v1/trading-day'])
/** preview: v4 (the v4 page builders); preview5: v5 (dashboard_rethink_v5.md). Each is its own uid suffix and folder. */
const PREVIEWS = { preview: { version: 'v4', pages: PAGES }, preview5: { version: 'v5', pages: PAGES.map((page) => ({ ...page, build: V5[page.uid] ?? page.build })) } }
function previewSource(fixtures) {
  const live = querySource('live', null, { liveRoutes: LIVE_ROUTES })
  const inline = querySource('fixture', fixtures.responses, { liveRoutes: LIVE_ROUTES, demo: new Set(Object.keys(fixtures.responses)) })
  return (path, o) => (PREVIEW_LIVE.has(path) ? live(path, o) : inline(path, o))
}

/** preview5live: the v5 pages whose Worker routes are all deployed (② ④, main 7aebf20f), every Worker route the checkout
 * serves read live (datasource sv-monitoring); only what has no source yet ('plan:', 'mock:') stays over mock.mjs.
 * Header links go to the preview uids: ② ④ here, ① ③ their v5 previews (preview5). */
const LIVE_PREVIEW = { version: 'v5live', pages: ['sv-health', 'sv-model'],
  links: { 'sv-today': 'sv-today-v5', 'sv-health': 'sv-health-v5live', 'sv-resources': 'sv-resources-v5', 'sv-model': 'sv-model-v5live' } }
/** preview6live: v6 ① ② ④ (today6, health6, model6) over the live monitoring Worker; routes not deployed yet (NOT_DEPLOYED) over mock.mjs. */
/** CALM_OK's hue lifted for text and borders (Wei 11/26): 6.58:1 on the canvas card #1e2228, 7.1:1 on the page #181b1f
 * (CALM_OK itself is 2.59:1 there, below the 4.5:1 text minimum). Fills keep CALM_OK. */
const CALM_OK_LINE = '#5fb3bb'
/** v6 palette over the v5 panels the v6 pages reuse (Wei 11/26): done / normal is CALM_OK as a fill (stat background,
 * gauge, mark disc, readiness dot), CALM_OK_LINE as text or a border (canvas edge and value, table text), DONE_DARK as a
 * large done area (state timeline, status history cells); amber and red stay for warnings and failures, and 綠 in the
 * words becomes 青. The v5 builders and the live pages keep C.ok: this rewrites only the v6 output. */
const V5_OK = C.ok.toLowerCase()
function recolor6(panel) {
  const large = ['state-timeline', 'status-history'].includes(panel.type)
  // `line`: the colour in this subtree is drawn as text or a border.
  const walk = (value, key, line) => {
    if (typeof value === 'string') {
      const lower = value.toLowerCase()
      if (lower === V5_OK || lower === CALM_OK) return large ? DONE_DARK : line ? CALM_OK_LINE : CALM_OK
      return key === 'description' || key === 'title' ? value.replaceAll('綠', '青') : value
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, undefined, line))
    if (!value || typeof value !== 'object') return value
    // A table's field (defaults or one override) draws its mapped colours as text unless its cells are colour-background.
    const cell = (props) => props?.find?.((p) => p.id === 'custom.cellOptions')?.value?.type
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      let next = line
      if (panel.type === 'canvas') {
        // Canvas value mappings: mk_* (state disc) and m_* (readiness dot) are fills; every other key colours a border or text.
        if (key === 'options' && typeof v === 'object' && v && 'color' in v) next = !(k.startsWith('mk_') || k.startsWith('m_'))
        else if (k === 'background') next = false
        else if (k === 'config' || k === 'border') next = true
      }
      if (panel.type === 'table') {
        if (k === 'properties' && Array.isArray(v)) next = cell(v) !== 'color-background'
        if (k === 'defaults' && v?.custom) next = v.custom.cellOptions?.type !== 'color-background'
      }
      return [k, walk(v, k, next)]
    }))
  }
  return walk(panel)
}
const V6_PREVIEW = { version: 'v6live', recolor: recolor6, pages: ['sv-today', 'sv-health', 'sv-model'], builders: { 'sv-today': today6, 'sv-health': health6, 'sv-model': model6 },
  links: { 'sv-today': 'sv-today-v6live', 'sv-health': 'sv-health-v6live', 'sv-resources': 'sv-resources-v5', 'sv-model': 'sv-model-v6live' } }
function buildLivePreview(preview = LIVE_PREVIEW) {
  const mock = mockResponses(new Date().toISOString())
  const live = querySource('live', null, { liveRoutes: LIVE_ROUTES })
  const inline = querySource('fixture', mock, { liveRoutes: LIVE_ROUTES, demo: new Set(Object.keys(mock)) })
  const deployed = (route) => LIVE_ROUTES.has(route) && !NOT_DEPLOYED.has(route)
  const q = (path, o) => (path.startsWith('/v1/') && deployed(path.split('?')[0]) ? live(path, o) : inline(path, o))
  return PAGES.filter((page) => preview.pages.includes(page.uid)).map((page) => {
    const panels = (preview.builders ?? V5)[page.uid](q, 'preview').flat().map((panel) => (preview.recolor ? preview.recolor(panel) : panel)).map((panel) => (isDemo(panel)
      ? Object.assign(panel, { title: panel.title && `${panel.title}（示範資料）`, description: `${DEMO}${panel.description ?? ''}` }) : panel))
    return dashboard({ uid: `${page.uid}-${preview.version}`, title: `${page.title}（預覽・真資料）`, panels, tag: 'stockvision-preview',
      time: page.live, refresh: page.refresh, links: page.links.map(([title, uid]) => [title, preview.links[uid] ?? uid]) })
  })
}

const DEMO = '示範資料。'
const isPlanned = (panel) => Boolean(panel.targets?.some((target) => target.planned))
const isDemo = (panel) => Boolean(panel.targets?.some((target) => target.demo))

/** Live: planned panels left out. Fixture: every panel, the ones over authored data marked 示範資料. Preview: every
 * panel on relative time, the ones not over live data titled 示範資料. */
function build(mode) {
  if (mode === 'preview5live') return buildLivePreview()
  if (mode === 'preview6live') return buildLivePreview(V6_PREVIEW)
  if (mode in PREVIEWS) return buildPreview(PREVIEWS[mode])
  const fixtures = mode === 'fixture' ? loadFixtures() : null
  const q = querySource(mode, fixtures?.responses, { liveRoutes: LIVE_ROUTES, demo: fixtures?.demo })
  return PAGES.map((page) => {
    const built = page.build(q, mode).flat()
    const panels = mode === 'live' ? built.filter((panel) => !isPlanned(panel))
      : built.map((panel) => (isDemo(panel) ? Object.assign(panel, { description: `${DEMO}${panel.description ?? ''}` }) : panel))
    return mode === 'live'
      ? dashboard({ uid: page.uid, title: page.title, panels, time: page.live, refresh: page.refresh,
        links: page.links.map(([title, uid]) => [title, LIVE_LINK_UIDS[uid] ?? uid]) })
      : dashboard({ uid: `${page.uid}-fixture`, title: `${page.title}（未接線：測試夾具與示範資料，不是 prod）`, panels, tag: 'stockvision-fixture',
        links: page.links.map(([title, uid]) => [title, `${uid}-fixture`]),
        // Fixture data is a snapshot of one evening, so the page is pinned to that evening.
        time: { from: new Date(fixtures.now - page.hours * 3600_000).toISOString(), to: new Date(fixtures.now).toISOString() } })
  })
}

function buildPreview({ version, pages }) {
  const q = previewSource(loadFixtures(Date.now()))
  const suffix = `-${version}`
  return pages.filter((page) => page.uid !== 'sv-mobile').map((page) => {
    const panels = page.build(q, 'preview').flat().map((panel) => (isDemo(panel)
      ? Object.assign(panel, { title: panel.title && `${panel.title}（示範資料）`, description: `${DEMO}${panel.description ?? ''}` }) : panel))
    return dashboard({ uid: `${page.uid}${suffix}`, title: `［預覽 ${version}${panels.some(isDemo) ? '・示範資料' : ''}］${page.title}`, panels,
      tag: 'stockvision-preview', time: page.live, refresh: page.refresh,
      links: page.links.map(([title, uid]) => [title, uid === 'sv-mobile' ? uid : `${uid}${suffix}`]) })
  })
}

/** Panels with everything that may differ between the two modes removed: where a query reads from (a billing query is
 * BigQuery live and authored rows in the fixture, so only its refId is compared), ids, the 示範資料 note, planned panels.
 * A Worker route over mock.mjs in the fixture is the live query over other data: compared in full. */
function comparable(board) {
  const strip = (target) => {
    if (target.datasource?.type === BIGQUERY_DS.type || target.standIn) return { refId: target.refId }
    const { datasource, source, url, url_options, data, ...rest } = target
    return rest
  }
  const panel = ({ id, datasource, description, targets, ...rest }) => ({ ...rest, description: (description ?? '').replace(DEMO, ''), targets: targets?.map(strip) })
  return JSON.stringify(board.panels.filter((p) => !isPlanned(p)).map(panel))
}

/** Words build.mjs makes from a raw field (rawErrors.mjs skips them): a readiness detail is the Worker's own description,
 * its codes read as words. */
const RAW_WORDS = [READINESS_DETAIL('detail')]
const rawHits = (board, where) => rawErrorHits(board, where, RAW_WORDS)
/** A snake_case name (a table, field or code) in a panel's title or ⓘ description: the reader sees code, not words. */
const codeWordHits = (board, where) => board.panels.flatMap((panel) => [panel.title, panel.description]
  .flatMap((text) => (text ?? '').match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? []).map((word) => `${where} 「${panel.title}」: ${word}`))
/** Every dashboard JSON on disk (live and preview-live in git; fixture/, git-ignored, when it was built), so one left
 * behind by a build change fails too. */
const keptBoards = () => [join(here, '..', 'dashboards'), join(here, '..', 'dashboards', 'fixture'), join(here, '..', 'preview-live')]
  .filter((dir) => existsSync(dir)).flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name)))

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const live = build('live'); const fixture = build('fixture')
  const raw = [...['live', 'fixture', 'preview5live', 'preview6live'].flatMap((mode) => (mode === 'live' ? live : mode === 'fixture' ? fixture : build(mode))
    .flatMap((board) => rawHits(board, `${mode} ${board.uid}`))),
    ...keptBoards().flatMap((file) => rawHits(JSON.parse(readFileSync(file, 'utf8')), file.slice(join(here, '..').length + 1)))]
  if (raw.length) { console.error(`raw error text shown (use error_brief; regenerate the JSON):\n${raw.join('\n')}`); process.exit(1) }
  const words = [...['live', 'fixture', 'preview5live', 'preview6live'].flatMap((mode) => (mode === 'live' ? live : mode === 'fixture' ? fixture : build(mode))
    .flatMap((board) => codeWordHits(board, `${mode} ${board.uid}`))),
    ...keptBoards().flatMap((file) => codeWordHits(JSON.parse(readFileSync(file, 'utf8')), file.slice(join(here, '..').length + 1)))]
  if (words.length) { console.error(`code names in a panel title or description (say it in words; regenerate the JSON):\n${words.join('\n')}`); process.exit(1) }
  // The live JSON in git is what gets published: it must be this build's output. Preview builds carry mock timestamps, so only live.
  const stale = live.filter((board) => { const file = join(here, '..', 'dashboards', `${board.uid}.json`)
    return !existsSync(file) || readFileSync(file, 'utf8') !== `${JSON.stringify(board, null, 1)}\n` }).map((board) => board.uid)
  if (stale.length) { console.error(`dashboards/*.json is not this build's output (run --mode live): ${stale.join(', ')}`); process.exit(1) }
  const differing = live.filter((board, i) => comparable(board) !== comparable(fixture[i])).map((board) => board.uid)
  if (differing.length) { console.error(`live and fixture panels differ: ${differing.join(', ')}`); process.exit(1) }
  const planned = fixture.map((board, i) => `${board.uid} +${board.panels.length - live[i].panels.length}`).join(', ')
  console.log(`${live.length} dashboards: live and fixture differ only in the query source (planned panels, fixture only: ${planned})`)
} else {
  const mode = args[args.indexOf('--mode') + 1]
  const preview = mode in PREVIEWS || mode === 'preview5live' || mode === 'preview6live'
  if (!(['live', 'fixture'].includes(mode) || preview) || (preview && !args.includes('--out'))) {
    console.error('usage: build.mjs --mode live|fixture | --mode preview|preview5|preview5live|preview6live --out <dir> | --check'); process.exit(2)
  }
  const out = preview ? args[args.indexOf('--out') + 1] : join(here, '..', 'dashboards', mode === 'fixture' ? 'fixture' : '')
  mkdirSync(out, { recursive: true })
  for (const board of build(mode)) {
    writeFileSync(join(out, `${board.uid}.json`), `${JSON.stringify(board, null, 1)}\n`)
    console.log(`${mode}: ${board.uid} (${board.panels.length} panels)`)
  }
}
