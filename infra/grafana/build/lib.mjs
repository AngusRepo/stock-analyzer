/** Panel builders shared by the StockVision dashboards. No dependencies; output is plain Grafana dashboard JSON. */

export const INFINITY = 'yesoreyeram-infinity-datasource'
/** Fixture builds read inline data, so any Infinity datasource works; the stack's default one is used. */
export const INLINE_DS = { type: INFINITY, uid: 'grafanacloud-infinity' }
/** Live builds read the monitoring Worker through an Infinity datasource whose base URL is the Worker's domain. */
export const LIVE_DS = { type: INFINITY, uid: 'sv-monitoring' }

/** Status colours (one set for every status panel, Grafana's own bright tones): green = done, light blue = running,
 * orange = late, red = failed, grey = not started. Price returns (Taiwan convention: up red, down green) are a separate pair
 * and are never drawn on a status panel. */
export const C = { ok: '#73bf69', run: '#8ab8ff', warn: '#ff9830', bad: '#f2495c', idle: '#5c606b', skip: '#464a52',
  dim: '#2B2D33', txt: '#e8e9ec', sub: '#a9abb3', line: '#7b808b' }

/** mark: state timeline / status history cell; text: table text, canvas label; edge: canvas border; node: canvas fill. */
const TONE = {
  ok: { mark: C.ok, text: '#96d98d', edge: C.ok, node: '#1e3a22' },
  run: { mark: C.run, text: '#a8caff', edge: C.run, node: '#1c2d4d' },
  warn: { mark: C.warn, text: '#ffb357', edge: C.warn, node: '#46300f' },
  bad: { mark: C.bad, text: '#ff7a8a', edge: C.bad, node: '#4d1a24' },
  idle: { mark: C.idle, text: '#9a9ea8', edge: '#5c606b', node: '#24272e' },
  skip: { mark: C.skip, text: '#7b808b', edge: '#464a52', node: '#1f2128' },
}

/** value → [label, tone]. One vocabulary for the Worker's display_status, state-table statuses, history results,
 * alert kinds and readiness tones; the label keeps the distinction the colour drops (逾時 vs 趕不上截止, 卡住 vs 失敗). */
export const STATUS = {
  completed: ['完成', 'ok'], success: ['完成', 'ok'], noop: ['無事可做', 'ok'], retry_success: ['重試後完成', 'ok'],
  running: ['執行中', 'run'], waiting: ['等待中', 'run'],
  not_started: ['未開始', 'idle'], pending: ['未開始', 'idle'], out_of_window: ['未到時段', 'idle'], stale: ['待確認', 'idle'],
  skipped: ['略過', 'skip'],
  at_risk: ['趕不上截止', 'warn'], attention: ['應跑未跑', 'warn'], overdue: ['逾時', 'warn'],
  stuck: ['卡住', 'bad'], missed: ['漏跑', 'bad'], failed: ['失敗', 'bad'], error: ['失敗', 'bad'], blocked: ['中止', 'bad'],
  ready: ['就緒', 'ok'], ok: ['正常', 'ok'], warn: ['注意', 'warn'], fail: ['未過', 'bad'], critical: ['重大', 'bad'], warning: ['注意', 'warn'],
  healthy: ['正常', 'ok'], pending_maturity: ['等待成熟', 'idle'], pass: ['通過', 'ok'], collecting: ['收集中', 'run'],
  not_applicable_no_real_intents: ['不適用（沒有真實下單）', 'idle'], owner_read_unavailable: ['讀不到來源', 'warn'],
}
/** Data-readiness status columns read in four words. Home-page rows use the Worker's ReadinessStatus
 * (ready / waiting / blocked / pending / running, from the quality ok / warn / fail), the freshness checks use ok / warn / fail. */
export const READINESS_VOCAB = { ready: ['正常', 'ok'], ok: ['正常', 'ok'], waiting: ['遲到', 'warn'], warn: ['遲到', 'warn'],
  blocked: ['缺漏', 'bad'], fail: ['缺漏', 'bad'], pending: ['未到', 'idle'], running: ['未到', 'idle'] }
export const STATUS_COLOR = (status, use = 'text') => TONE[STATUS[status][1]][use]
/** JSONata object literal: status → label, for text the Worker's status vocabulary is turned into. */
export const STATUS_LABELS_JSONATA = JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([key, [label]]) => [key, label])))

/** `use`: 'text' (tables), 'mark' (state timeline / status history) or 'canvas' (key → border, f_key → fill, c_key → label). */
export function statusMappings(use = 'text', vocabulary = STATUS) {
  const options = {}
  let index = 0
  for (const [key, [text, toneName]] of Object.entries(vocabulary)) {
    const tone = TONE[toneName]
    if (use !== 'canvas') { options[key] = { text, color: tone[use], index: index++ }; continue }
    options[key] = { text, color: tone.edge, index: index++ }
    options[`f_${key}`] = { text: 'f', color: tone.node, index: index++ }
    options[`c_${key}`] = { text: 'c', color: tone.text, index: index++ }
  }
  return [{ type: 'value', options }]
}

export const gp = (x, y, w, h) => ({ x, y, w, h })
export const th = (...steps) => ({ mode: 'absolute', steps: steps.map(([color, value]) => ({ color, value })) })
const col = (selector, text, type = 'string') => ({ selector, text, type })
export const S = (selector, text) => col(selector, text, 'string')
export const N = (selector, text) => col(selector, text, 'number')
export const T = (selector, text) => col(selector, text, 'timestamp')

/** Query factory. `live`: GET the endpoint; `fixture`: the same response embedded inline. Everything else is identical.
 * `root` is JSONata. Infinity's backend parser only evaluates a selector as JSONata when it starts with `(` or `$`
 * (anything else quietly yields one row of nulls), and fails the query when the expression matches nothing, so every
 * selector is sent as `([ … ])`: always JSONata, and an empty match is an empty table (alerts are empty on a good day). */
export function querySource(mode, fixtures) {
  return (path, { root, columns = [], refId = 'A' } = {}) => {
    const base = { refId, type: 'json', parser: 'backend', format: 'table', root_selector: `([${root}])`, columns, filters: [] }
    if (mode === 'live') return { ...base, datasource: LIVE_DS, source: 'url', url: path, url_options: { method: 'GET', data: '' } }
    if (!(path in fixtures)) throw new Error(`no fixture for ${path}`)
    return { ...base, datasource: INLINE_DS, source: 'inline', data: JSON.stringify(fixtures[path]) }
  }
}

const overridesFor = (o) => {
  const out = []
  // Null cells read "—"; the panel-wide noValue is the empty-table message.
  out.push({ matcher: { id: 'byRegexp', options: '.*' }, properties: [{ id: 'noValue', value: '—' }] })
  for (const name of o.status ?? []) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: statusMappings('text', o.vocabulary) }] })
  for (const [name, g] of Object.entries(o.gauge ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'gauge', mode: g.mode ?? 'basic', valueDisplayMode: 'text' } }, { id: 'min', value: g.min ?? 0 },
    { id: 'max', value: g.max }, { id: 'unit', value: g.unit ?? 'none' }, { id: 'thresholds', value: g.th ?? th([C.ok, null]) }, { id: 'color', value: { mode: 'thresholds' } }] })
  // An empty cell would take the lowest step's colour; it stays a plain dash.
  for (const [name, steps] of Object.entries(o.num ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'thresholds', value: th(...steps) }, { id: 'color', value: { mode: 'thresholds' } },
    { id: 'mappings', value: [{ type: 'special', options: { match: 'null', result: { text: '—', color: C.sub, index: 0 } } }] }] })
  for (const [name, unit] of Object.entries(o.unit ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'unit', value: unit }] })
  for (const [name, width] of Object.entries(o.wd ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'custom.width', value: width }] })
  return out
}

/** The backend parser returns columns in alphabetical order; `organize` restores the order they were declared in. */
const declaredOrder = (targets, hide = []) => ({ id: 'organize', options: { excludeByName: Object.fromEntries(hide.map((name) => [name, true])), renameByName: {},
  indexByName: Object.fromEntries(targets.flatMap((target) => target.columns).map((c, i) => [c.text, i])) } })

export const text = (content, x, y, w, h) => ({ type: 'text', title: '', transparent: true, gridPos: gp(x, y, w, h), options: { mode: 'markdown', content } })

/** Shown instead of an empty panel: a source not wired yet, unless the panel says what empty means (o.empty). */
export const NO_SOURCE = '尚未接資料'

/** `target`: one query, or several with the same columns, whose rows are stacked (merge). Sorting happens before
 * `hide` drops the sort key. */
export function table(title, target, x, y, w, h, o = {}) {
  const targets = [target].flat()
  const sort = o.sort ? [{ id: 'sortBy', options: { fields: {}, sort: [{ field: o.sort, desc: Boolean(o.desc_sort) }] } }] : []
  return { type: 'table', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    transformations: [...(targets.length > 1 ? [{ id: 'merge', options: {} }] : []), ...sort, declaredOrder(targets, o.hide)],
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
    fieldConfig: { defaults: { custom: { align: 'left', inspect: false }, noValue: o.empty ?? NO_SOURCE }, overrides: overridesFor(o) } }
}

/** The join key of a multi-query KPI strip: each query's selector returns `'k': 1` and lists this column. */
export const KPI_KEY = N('k', 'k')

/** Several single-row queries as one row: joined on the constant `k` each returns. The join names every other field
 * "<text> <refId>", so they are put back in declared order under their own names. */
function joinedOrder(targets) {
  const fields = targets.flatMap((target) => target.columns.filter((c) => c.text !== KPI_KEY.text).map((c) => [`${c.text} ${target.refId}`, c.text]))
  return [{ id: 'joinByField', options: { byField: KPI_KEY.text, mode: 'outer' } },
    { id: 'organize', options: { excludeByName: { [KPI_KEY.text]: true }, indexByName: Object.fromEntries(fields.map(([joined], i) => [joined, i])),
      renameByName: Object.fromEntries(fields) } }]
}

/** One compact strip of numbers: small title, 20px value, one field per number. `fields`: [{ name, unit, dec, th, mappings }]. */
export function kpi(title, targets, x, y, w, h, fields) {
  return { type: 'stat', title, gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    transformations: targets.length > 1 ? joinedOrder(targets) : [declaredOrder(targets)],
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '/.*/', values: false }, orientation: 'auto', textMode: 'value_and_name', wideLayout: false,
      colorMode: 'value', graphMode: 'none', justifyMode: 'auto', showPercentChange: false, text: { titleSize: 12, valueSize: 20 } },
    // A null number reads "—" (e.g. no unfinished stage, so no margin); NO_SOURCE is only for a panel with no data at all.
    fieldConfig: { defaults: { thresholds: th([C.txt, null]), noValue: NO_SOURCE }, overrides: [
      { matcher: { id: 'byRegexp', options: '.*' }, properties: [{ id: 'noValue', value: '—' }] },
      ...fields.map((f) => ({ matcher: { id: 'byName', options: f.name }, properties: [
      { id: 'unit', value: f.unit ?? 'none' }, { id: 'decimals', value: f.dec ?? 0 }, { id: 'thresholds', value: f.th ?? th([C.txt, null]) },
      ...(f.mappings ? [{ id: 'mappings', value: f.mappings }] : [])] }))] } }
}

/** State timeline / status history over long rows (time, <by>, <value>): one row per distinct <by>, in order of first appearance. */
export function states(kind, title, target, by, x, y, w, h, o = {}) {
  return { type: kind, title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    timeFrom: o.timeFrom, hideTimeOverride: true,
    transformations: [{ id: 'partitionByValues', options: { fields: [by], keepFields: false, naming: { asLabels: true } } }],
    options: { legend: { showLegend: false }, tooltip: { mode: 'single' }, showValue: 'never', rowHeight: 0.7, ...(o.opts ?? {}) },
    fieldConfig: { defaults: { displayName: `\${__field.labels.${by}}`, noValue: o.empty ?? NO_SOURCE, mappings: statusMappings('mark'), color: { mode: 'thresholds' },
      thresholds: th([C.dim, null]), custom: { fillOpacity: 80, lineWidth: 0 } }, overrides: [] } }
}

export function bars(title, target, valueField, x, y, w, h, o = {}) {
  return { type: 'bargauge', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { reduceOptions: { values: true, calcs: [], fields: `/^${valueField}$/`, limit: 40 }, orientation: 'horizontal', displayMode: 'basic',
      valueMode: 'color', showUnfilled: true, namePlacement: 'left', minVizHeight: 12, minVizWidth: 8, maxVizHeight: 18, sizing: 'manual', text: { titleSize: 12, valueSize: 13 } },
    fieldConfig: { defaults: { unit: o.unit ?? 'percent', min: o.min ?? 0, max: o.max ?? 100, noValue: o.empty ?? NO_SOURCE, thresholds: o.th ?? th([C.ok, null], [C.warn, 80], [C.bad, 100]) }, overrides: [] } }
}

/** Donut over one row of counts: each field is a slice. `slices`: [[field name, colour]] in legend order. */
export function donut(title, target, x, y, w, h, slices, o = {}) {
  return { type: 'piechart', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    transformations: [declaredOrder([target])],
    options: { pieType: 'donut', reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' }, displayLabels: [], tooltip: { mode: 'single' },
      legend: { showLegend: true, displayMode: 'table', placement: 'right', values: ['value', 'percent'] } },
    fieldConfig: { defaults: { unit: 'none', decimals: 0, noValue: o.empty ?? NO_SOURCE }, overrides: slices.map(([name, color]) => ({
      matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } }
}

/** Vertical stacked bars over a string x field: one query per series, joined on `xField`. `series`: [[field name, colour]]. */
export function stackedBars(title, targets, xField, x, y, w, h, series, o = {}) {
  const fields = targets.flatMap((target) => target.columns.filter((c) => c.text !== xField).map((c) => [`${c.text} ${target.refId}`, c.text]))
  return { type: 'barchart', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    transformations: [
      ...(targets.length > 1 ? [{ id: 'joinByField', options: { byField: xField, mode: 'outerTabular' } }] : []),
      { id: 'sortBy', options: { fields: {}, sort: [{ field: xField, desc: false }] } },
      { id: 'organize', options: { excludeByName: {}, indexByName: {}, renameByName: Object.fromEntries(fields) } }],
    options: { xField, orientation: 'vertical', stacking: 'normal', showValue: 'never', barWidth: 0.7, groupWidth: 0.7, barRadius: 0,
      xTickLabelRotation: 0, xTickLabelSpacing: 0, fullHighlight: false, tooltip: { mode: 'multi' },
      legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] } },
    fieldConfig: { defaults: { unit: 'none', decimals: 0, min: 0, custom: { fillOpacity: 90, lineWidth: 0, axisSoftMin: 0, axisPlacement: 'auto' } },
      overrides: series.map(([name, color]) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } }
}

/** Radial gauges, one per row: `nameField` names each gauge, the row's one number fills it. */
export function gauges(title, target, nameField, x, y, w, h, o = {}) {
  return { type: 'gauge', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { reduceOptions: { values: true, calcs: [], fields: '' }, orientation: 'auto', showThresholdMarkers: true, showThresholdLabels: false,
      sizing: 'auto', minVizWidth: 75, minVizHeight: 75, text: { titleSize: 12, valueSize: 18 } },
    fieldConfig: { defaults: { displayName: `\${__data.fields.${nameField}}`, unit: o.unit ?? 'percent', decimals: o.dec ?? 1, min: o.min ?? 0, max: o.max ?? 100,
      noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' }, thresholds: o.th ?? th([C.ok, null], [C.warn, 80], [C.bad, 90]) }, overrides: [] } }
}

export const row = (title, y, panels) => ({ type: 'row', title, gridPos: gp(0, y, 24, 1), collapsed: true, panels })

/** `links`: [title, dashboard uid] shown next to the page list (desktop ↔ mobile); `pageList: false` leaves the list out. */
export function dashboard({ uid, title, panels, time, refresh = '', tag = 'stockvision', links = [], pageList = true }) {
  let id = 0
  for (const panel of panels) { panel.id = ++id; for (const child of panel.panels ?? []) child.id = ++id }
  return { uid, title, tags: [tag], timezone: 'Asia/Taipei', editable: true, schemaVersion: 39, refresh, time,
    links: [...(pageList ? [{ title: 'StockVision', type: 'dashboards', tags: [tag], asDropdown: false, includeVars: false, keepTime: false }] : []),
      ...links.map(([linkTitle, target]) => ({ title: linkTitle, type: 'link', url: `/d/${target}`, icon: 'dashboard', asDropdown: false, includeVars: false, keepTime: false, targetBlank: false, tags: [], tooltip: '' }))],
    templating: { list: [] }, panels }
}
