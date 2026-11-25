/** Panel builders shared by the StockVision dashboards. No dependencies; output is plain Grafana dashboard JSON. */

export const INFINITY = 'yesoreyeram-infinity-datasource'
/** Fixture builds read inline data, so any Infinity datasource works; the stack's default one is used. */
export const INLINE_DS = { type: INFINITY, uid: 'grafanacloud-infinity' }
/** Live builds read the monitoring Worker through an Infinity datasource whose base URL is the Worker's domain. */
export const LIVE_DS = { type: INFINITY, uid: 'sv-monitoring' }

export const C = { ok: '#56A64B', run: '#5794F2', idle: '#6E7079', warn: '#FF9830', bad: '#E02F44', stuck: '#B877D9', skip: '#4B4F58',
  retry: '#EAB839', dim: '#2B2D33', txt: '#D0D2D8', sub: '#8E919A', line: '#5c606b' }

/** value → [label, colour, node fill]. One vocabulary for the Worker's display_status, state-table statuses,
 * history results, alert kinds and readiness tones. Red and orange are kept for what needs action. */
export const STATUS = {
  completed: ['完成', C.ok, '#15231a'], success: ['完成', C.ok, '#15231a'], noop: ['無事可做', C.ok, '#15231a'],
  retry_success: ['重試後完成', C.retry, '#2b2610'],
  running: ['執行中', C.run, '#14233d'], waiting: ['等待中', C.run, '#14233d'],
  not_started: ['未開始', C.idle, '#191b20'], pending: ['未開始', C.idle, '#191b20'], out_of_window: ['未到時段', C.idle, '#191b20'],
  skipped: ['略過', C.skip, '#191b20'], stale: ['待確認', C.idle, '#191b20'],
  at_risk: ['趕不上截止', C.retry, '#2b2610'], attention: ['應跑未跑', C.warn, '#33240f'], overdue: ['逾時', C.warn, '#33240f'],
  stuck: ['卡住', C.stuck, '#2a1c38'], missed: ['漏跑', C.bad, '#391418'],
  failed: ['失敗', C.bad, '#391418'], error: ['失敗', C.bad, '#391418'], blocked: ['中止', C.bad, '#391418'],
  ready: ['就緒', C.ok], ok: ['正常', C.ok], warn: ['注意', C.warn], fail: ['未過', C.bad], critical: ['重大', C.bad], warning: ['注意', C.warn],
  healthy: ['正常', C.ok], pending_maturity: ['等待成熟', C.idle], pass: ['通過', C.ok], collecting: ['收集中', C.run], not_applicable_no_real_intents: ['不適用（沒有真實下單）', C.idle],
  owner_read_unavailable: ['讀不到來源', C.warn],
}
/** JSONata object literal: status → label, for text the Worker's status vocabulary is turned into. */
export const STATUS_LABELS_JSONATA = JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([key, [label]]) => [key, label])))

export function statusMappings({ fills = false, dimIdle = false } = {}) {
  const options = {}
  let index = 0
  for (const [key, [label, colour, fill]] of Object.entries(STATUS)) {
    options[key] = { text: label, color: dimIdle && colour === C.idle ? 'rgba(110,112,121,0.12)' : colour, index: index++ }
    if (fills && fill) options[`f_${key}`] = { text: 'f', color: fill, index: index++ }
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
  for (const name of o.status ?? []) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: statusMappings() }] })
  for (const [name, g] of Object.entries(o.gauge ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'gauge', mode: g.mode ?? 'basic', valueDisplayMode: 'text' } }, { id: 'min', value: g.min ?? 0 },
    { id: 'max', value: g.max }, { id: 'unit', value: g.unit ?? 'none' }, { id: 'thresholds', value: g.th ?? th([C.ok, null]) }, { id: 'color', value: { mode: 'thresholds' } }] })
  for (const [name, steps] of Object.entries(o.num ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'thresholds', value: th(...steps) }, { id: 'color', value: { mode: 'thresholds' } }] })
  for (const [name, unit] of Object.entries(o.unit ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'unit', value: unit }] })
  for (const [name, width] of Object.entries(o.wd ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'custom.width', value: width }] })
  return out
}

/** The backend parser returns columns in alphabetical order; `organize` restores the order they were declared in. */
const declaredOrder = (...targets) => ({ id: 'organize', options: { excludeByName: {}, renameByName: {},
  indexByName: Object.fromEntries(targets.flatMap((target) => target.columns).map((c, i) => [c.text, i])) } })

export const text = (content, x, y, w, h) => ({ type: 'text', title: '', transparent: true, gridPos: gp(x, y, w, h), options: { mode: 'markdown', content } })

/** `target`: one query, or several with the same columns, whose rows are stacked (merge). */
export function table(title, target, x, y, w, h, o = {}) {
  const targets = [target].flat()
  return { type: 'table', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    transformations: [...(targets.length > 1 ? [{ id: 'merge', options: {} }] : []), declaredOrder(targets[0]), ...(o.sort ? [{ id: 'sortBy', options: { fields: {}, sort: [{ field: o.sort, desc: Boolean(o.desc_sort) }] } }] : [])],
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
    fieldConfig: { defaults: { custom: { align: 'left', inspect: false }, noValue: '—' }, overrides: overridesFor(o) } }
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
    transformations: targets.length > 1 ? joinedOrder(targets) : [declaredOrder(...targets)],
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '/.*/', values: false }, orientation: 'auto', textMode: 'value_and_name', wideLayout: false,
      colorMode: 'value', graphMode: 'none', justifyMode: 'auto', showPercentChange: false, text: { titleSize: 12, valueSize: 20 } },
    fieldConfig: { defaults: { thresholds: th([C.txt, null]), noValue: '—' }, overrides: fields.map((f) => ({ matcher: { id: 'byName', options: f.name }, properties: [
      { id: 'unit', value: f.unit ?? 'none' }, { id: 'decimals', value: f.dec ?? 0 }, { id: 'thresholds', value: f.th ?? th([C.txt, null]) },
      ...(f.mappings ? [{ id: 'mappings', value: f.mappings }] : [])] })) } }
}

/** State timeline / status history over long rows (time, <by>, <value>): one row per distinct <by>, in order of first appearance. */
export function states(kind, title, target, by, x, y, w, h, o = {}) {
  return { type: kind, title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    timeFrom: o.timeFrom, hideTimeOverride: true,
    transformations: [{ id: 'partitionByValues', options: { fields: [by], keepFields: false, naming: { asLabels: true } } }],
    options: { legend: { showLegend: false }, tooltip: { mode: 'single' }, showValue: 'never', rowHeight: 0.8, ...(o.opts ?? {}) },
    fieldConfig: { defaults: { displayName: `\${__field.labels.${by}}`, mappings: statusMappings({ dimIdle: true }), color: { mode: 'thresholds' },
      thresholds: th([C.dim, null]), custom: { fillOpacity: 80, lineWidth: 0 } }, overrides: [] } }
}

export function bars(title, target, valueField, x, y, w, h, o = {}) {
  return { type: 'bargauge', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { reduceOptions: { values: true, calcs: [], fields: `/^${valueField}$/`, limit: 40 }, orientation: 'horizontal', displayMode: o.mode ?? 'lcd',
      valueMode: 'color', showUnfilled: true, namePlacement: 'left', minVizHeight: 12, minVizWidth: 8, maxVizHeight: 18, sizing: 'manual', text: { titleSize: 12, valueSize: 13 } },
    fieldConfig: { defaults: { unit: o.unit ?? 'percent', min: o.min ?? 0, max: o.max ?? 100, noValue: '—', thresholds: o.th ?? th([C.ok, null], [C.retry, 65], [C.bad, 90]) }, overrides: [] } }
}

export const row = (title, y, panels) => ({ type: 'row', title, gridPos: gp(0, y, 24, 1), collapsed: true, panels })

export function dashboard({ uid, title, panels, time, refresh = '', tag = 'stockvision' }) {
  let id = 0
  for (const panel of panels) { panel.id = ++id; for (const child of panel.panels ?? []) child.id = ++id }
  return { uid, title, tags: [tag], timezone: 'Asia/Taipei', editable: true, schemaVersion: 39, refresh, time,
    links: [{ title: 'StockVision', type: 'dashboards', tags: [tag], asDropdown: false, includeVars: false, keepTime: false }],
    templating: { list: [] }, panels }
}
