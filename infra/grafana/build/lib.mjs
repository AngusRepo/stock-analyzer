/** Panel builders shared by the StockVision dashboards. No dependencies; output is plain Grafana dashboard JSON. */

export const INFINITY = 'yesoreyeram-infinity-datasource'
/** Fixture builds read inline data, so any Infinity datasource works; the stack's default one is used. */
export const INLINE_DS = { type: INFINITY, uid: 'grafanacloud-infinity' }
/** Live builds read the monitoring Worker through an Infinity datasource whose base URL is the Worker's domain. */
export const LIVE_DS = { type: INFINITY, uid: 'sv-monitoring' }
/** Google Cloud Monitoring (already live) and the BigQuery billing export (to be created with this uid). Both read the
 * same in live and fixture builds. */
export const GCP_DS = { type: 'stackdriver', uid: 'bg59sppgm7v9cb' }
export const BIGQUERY_DS = { type: 'grafana-bigquery-datasource', uid: 'sv-bigquery' }

/** Status colours (one set for every status panel): green = done (#00c076, the OBS page's --chart-3), blue = running, light grey = waiting / not started,
 * dark grey = skipped, amber = late or at risk, red = failed. No red/green pair; saturated tones only where something
 * needs action. Price returns are drawn in neutral tones, never in status colours. */
export const C = { ok: '#00c076', run: '#8ab8ff', warn: '#ff9830', bad: '#f2495c', idle: '#5c606b', skip: '#464a52',
  dim: '#2B2D33', txt: '#e8e9ec', sub: '#a9abb3', line: '#7b808b' }

/** Every colour that is not a status (categories, accents, sequential scales) is cool, so warm tones (amber, red) on a page
 * only ever mean "needs action". Checked with the dataviz skill's validate_palette.js on the dark surface #181b1f:
 * `cat` (cyan, blue, violet, purple; lightness alternates 0.64 / 0.52 / 0.67 / 0.54) passes every check with --pairs all
 * (worst CVD ΔE 9.0, worst normal-vision ΔE 17.1, all ≥ 3:1), and each slot is ≥ 15 ΔE from every status colour in C
 * (the cyan was moved bluer for C.ok #00c076: ΔE 16.4 normal, 15.2 under CVD; the old #0ca1b2 was 14.5).
 * A chart has at most four categories in colour; the rest fold into `other` (a near-white grey, ≥ 15 ΔE from `cat` and
 * from C.run). `calm`: a quiet steel blue for a normal value that is not a status; `loss`: a muted red for an area that
 * is a loss, not an alert. `seq`: heatmaps in opacity mode, one hue each from the background (nothing) to a light tint
 * (the peak), in five steps. `margin`: the three cool bands of the deadline-margin grid, 10–30 / 30–60 / ≥ 60 minutes
 * (grey blue L 0.78, cyan L 0.62, deep blue L 0.44: one hue within 23°, adjacent ΔE ≥ 18 normal and ≥ 14 CVD); under
 * 10 minutes is C.warn and past the deadline C.bad, as on the Canvas. */
export const COOL = {
  cat: ['#199cb8', '#035ede', '#a573fe', '#ac27ae'],
  other: '#dcdfe4', calm: '#3b5874', loss: '#b05a68',
  seq: { reads: '#b7d3f6', writes: '#d2c4ff', latency: '#9fe3ea' },
  margin: ['#a7bacd', '#1f93b8', '#16587f'],
}

/** mark: state timeline / status history cell, dot; text: table text, canvas value; edge: canvas border. Boxes and cards
 * are never filled with a status: done is drawn as the OBS page draws it, #00c076 text, edge and mark on a neutral card. */
export const TONE = {
  ok: { mark: C.ok, text: C.ok, edge: C.ok },
  run: { mark: C.run, text: '#a8caff', edge: C.run },
  warn: { mark: C.warn, text: '#ffb357', edge: C.warn },
  bad: { mark: C.bad, text: '#ff7a8a', edge: C.bad },
  idle: { mark: C.idle, text: '#9a9ea8', edge: '#5c606b' },
  skip: { mark: C.skip, text: '#7b808b', edge: '#464a52' },
}

/** value → [label, tone]. One vocabulary for the Worker's display_status, state-table statuses, history results,
 * alert kinds and readiness tones; the label keeps the distinction the colour drops (逾時 vs 趕不上截止, 卡住 vs 失敗). */
export const STATUS = {
  completed: ['完成', 'ok'], success: ['完成', 'ok'], noop: ['無事可做', 'ok'], retry_success: ['重試後完成', 'ok'],
  running: ['執行中', 'run'], waiting: ['等待中', 'idle'],
  not_started: ['未開始', 'idle'], pending: ['未開始', 'idle'], out_of_window: ['未到時段', 'idle'], stale: ['待確認', 'idle'],
  skipped: ['略過', 'skip'],
  at_risk: ['趕不上截止', 'warn'], attention: ['應跑未跑', 'warn'], overdue: ['逾時', 'warn'],
  stuck: ['卡住', 'bad'], missed: ['漏跑', 'bad'], failed: ['失敗', 'bad'], error: ['失敗', 'bad'], blocked: ['中止', 'bad'],
  // A watcher (intraday-check) held back: the alert kind `blocked` and a watcher's display_status `blocked` (Wei 11/26:
  // a warning, not overdue). Panels translate both into this key (ALERT_KIND, canvas $ds, build.mjs RESULT); a chain stage's
  // blocked (aborted there) stays 中止.
  watcher_blocked: ['被擋住', 'warn'],
  ready: ['就緒', 'ok'], ok: ['正常', 'ok'], warn: ['注意', 'warn'], fail: ['未過', 'bad'], critical: ['重大', 'bad'], warning: ['注意', 'warn'],
  healthy: ['正常', 'ok'], pending_maturity: ['等待成熟', 'idle'], pass: ['通過', 'ok'], collecting: ['收集中', 'run'],
  not_applicable_no_real_intents: ['不適用（沒有真實下單）', 'idle'], owner_read_unavailable: ['讀不到來源', 'warn'],
  match: ['一致', 'ok'], drift: ['漂移', 'warn'], missing: ['缺少', 'bad'], invalid: ['無效', 'bad'], PASS: ['通過', 'ok'], FAIL: ['未過', 'bad'],
}
/** Data-readiness status columns read in four words. Home-page rows use the Worker's ReadinessStatus
 * (ready / waiting / blocked / pending / running, from the quality ok / warn / fail), the freshness checks use ok / warn / fail. */
export const READINESS_VOCAB = { ready: ['正常', 'ok'], ok: ['正常', 'ok'], waiting: ['遲到', 'warn'], warn: ['遲到', 'warn'],
  blocked: ['缺漏', 'bad'], fail: ['缺漏', 'bad'], pending: ['未到', 'idle'], running: ['未到', 'idle'] }
/** JSONata: an alert's kind as a STATUS key (the alert kind `blocked` is only ever a watcher's). */
export const ALERT_KIND = (kind = 'kind') => `(${kind} = 'blocked' ? 'watcher_blocked' : ${kind})`
export const STATUS_COLOR = (status, use = 'text') => TONE[STATUS[status][1]][use]
/** JSONata object literal: status → label, for text the Worker's status vocabulary is turned into. */
export const STATUS_LABELS_JSONATA = JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([key, [label]]) => [key, label])))

/** `use`: 'text' (tables) or 'mark' (state timeline / status history). */
export function statusMappings(use = 'text', vocabulary = STATUS) {
  const options = {}
  Object.entries(vocabulary).forEach(([key, [text, toneName]], index) => { options[key] = { text, color: TONE[toneName][use], index } })
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
export function querySource(mode, fixtures, { liveRoutes, demo = new Set() } = {}) {
  return (path, { root, columns = [], refId = 'A' } = {}) => {
    const base = { refId, type: 'json', parser: 'backend', format: 'table', root_selector: `([${root}])`, columns, filters: [] }
    // planned: no live source yet ('plan:' paths, or a Worker route not in this checkout); demo: the fixture is authored;
    // standIn: authored rows standing in for a query of another datasource ('mock:', the BigQuery billing queries).
    const planned = path.startsWith('plan:') || Boolean(liveRoutes && path.startsWith('/v1/') && !liveRoutes.has(path.split('?')[0]))
    const target = mode === 'live' ? { ...base, datasource: LIVE_DS, source: 'url', url: path, url_options: { method: 'GET', data: '' } } : null
    if (!target && !(path in fixtures)) throw new Error(`no fixture for ${path}`)
    return marked(target ?? { ...base, datasource: INLINE_DS, source: 'inline', data: JSON.stringify(fixtures[path]) },
      { planned, demo: mode !== 'live' && demo.has(path), standIn: path.startsWith('mock:') })
  }
}
/** A value as a JSONata literal: its JSON, with `<`, `>` and the two JSON-legal line separators escaped (the same string to
 * JSONata, and no text from a catalog can close or split the query it is written into). */
export const lit = (value) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
/** Build-time flags on a target, kept out of the JSON (not enumerable). */
export const marked = (target, flags) => {
  for (const [flag, on] of Object.entries(flags)) if (on) Object.defineProperty(target, flag, { value: true })
  return target
}

const overridesFor = (o) => {
  const out = []
  // Null cells read "—"; the panel-wide noValue is the empty-table message.
  out.push({ matcher: { id: 'byRegexp', options: '.*' }, properties: [{ id: 'noValue', value: '—' }] })
  for (const name of o.status ?? []) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'mappings', value: statusMappings('text', o.vocabulary) }] })
  // Solid cells: a table gauge cell fills its bar at 35% opacity in every mode but lcd (whose cells take each step's
  // colour along the bar, so a passing value would show red and amber too), so a value judged by thresholds is a cell
  // filled with its step's colour; the number is the magnitude.
  for (const [name, g] of Object.entries(o.solid ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } }, { id: 'unit', value: g.unit ?? 'none' },
    ...(g.dec != null ? [{ id: 'decimals', value: g.dec }] : []), { id: 'thresholds', value: g.th }, { id: 'color', value: { mode: 'thresholds' } }] })
  // An empty cell would take the lowest step's colour; it stays a plain dash.
  for (const [name, steps] of Object.entries(o.num ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [
    { id: 'custom.cellOptions', value: { type: 'color-text' } }, { id: 'thresholds', value: th(...steps) }, { id: 'color', value: { mode: 'thresholds' } },
    { id: 'mappings', value: [{ type: 'special', options: { match: 'null', result: { text: '—', color: C.sub, index: 0 } } }] }] })
  for (const [name, unit] of Object.entries(o.unit ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'unit', value: unit }] })
  for (const [name, width] of Object.entries(o.wd ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'custom.width', value: width }] })
  // A floor, not a fixed width: the column still takes its share of a wide panel, and its header never truncates on a phone.
  for (const [name, width] of Object.entries(o.mw ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'custom.minWidth', value: width }] })
  // Detail columns stay in the frame for the links but are not drawn; the links' titles are the detail.
  for (const name of o.hidden ?? []) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'custom.hidden', value: true }] })
  for (const [name, fields] of Object.entries(o.details ?? {})) out.push({ matcher: { id: 'byName', options: name }, properties: [{ id: 'links', value: detailLinks(fields) }] })
  return out
}

/** Detail text a click on a cell or tile shows: one data link per field, titled with that field's value. Two or more
 * links open Grafana's link menu (one would navigate straight away); each link reloads this page. */
export const detailLinks = (fields) => fields.map((name) => ({ title: `\${__data.fields["${name}"]}`, url: '/d/${__dashboard.uid}?${__url_time_range}', targetBlank: false }))

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
    fieldConfig: { defaults: { custom: { align: 'left', inspect: false, ...(o.minWidth ? { minWidth: o.minWidth } : {}) }, noValue: o.empty ?? NO_SOURCE }, overrides: overridesFor(o) } }
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

/** State timeline / status history over long rows (time, <by>, <value>): one row per distinct <by>, in order of first appearance.
 * `o.mappings`: value → colour other than the status vocabulary (e.g. OPB arms). */
export function states(kind, title, target, by, x, y, w, h, o = {}) {
  const targets = [target].flat()
  return { type: kind, title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    timeFrom: o.timeFrom, hideTimeOverride: true,
    // Several queries (same columns) are stacked into one table first, or only the first one would be split into rows.
    transformations: [...(targets.length > 1 ? [{ id: 'merge', options: {} }] : []),
      { id: 'partitionByValues', options: { fields: [by], keepFields: false, naming: { asLabels: true } } }],
    options: { legend: { showLegend: Boolean(o.legend), displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single' }, showValue: 'never',
      // Gaps between rows (and between a status history's cells) keep a long run of solid green from reading as one block.
      ...(kind === 'status-history' ? { rowHeight: 0.8, colWidth: 0.85 } : { rowHeight: 0.7 }), ...(o.opts ?? {}) },
    fieldConfig: { defaults: { displayName: `\${__field.labels.${by}}`, noValue: o.empty ?? NO_SOURCE, mappings: o.mappings ?? statusMappings('mark'),
      // Solid: below 100 the status colours are mixed with the dark background (#00c076 at 80% renders #00a364).
      color: { mode: 'thresholds' }, thresholds: th([C.dim, null]), custom: { fillOpacity: 100, lineWidth: 0 } }, overrides: [] } }
}

/** One gauge per row (a quota, a capacity, progress to a threshold): `nameField` names it, `valueField` fills it from
 * o.min to o.max; the threshold steps colour the arc and mark the band. */
export function gauges(title, target, nameField, valueField, x, y, w, h, o = {}) {
  return { type: 'gauge', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { reduceOptions: { values: true, calcs: [], fields: allBut(target, valueField), limit: 40 }, orientation: 'auto', showThresholdMarkers: true,
      showThresholdLabels: false, sizing: 'auto', minVizWidth: 60, minVizHeight: 60, text: { titleSize: 12, valueSize: 20 } },
    fieldConfig: { defaults: { unit: o.unit ?? 'percent', decimals: o.dec ?? 0, min: o.min ?? 0, max: o.max ?? 100, noValue: o.empty ?? NO_SOURCE,
      color: { mode: 'thresholds' }, thresholds: o.th ?? th([C.ok, null], [C.warn, 80], [C.bad, 90]) }, overrides: [rowName(valueField, nameField)] } }
}

/** Donut of parts of a whole. Default: one row whose fields are the slices (`o.colors`: [[field, colour]]). `o.byRow`:
 * [nameField, valueField], one slice per row (names not known in advance, palette colours). */
export function donut(title, target, x, y, w, h, o = {}) {
  const [nameField, valueField] = o.byRow ?? []
  // `o.byRow`: rows of (name, value) become one field each (rowsToFields), so `o.colors` can colour a slice by its name and
  // any name not listed takes `o.fallback`.
  return { type: 'piechart', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    transformations: o.byRow ? [{ id: 'rowsToFields', options: { mappings: [{ fieldName: nameField, handlerKey: 'field.name' }, { fieldName: valueField, handlerKey: 'field.value' }] } }] : [],
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' },
      pieType: 'donut', displayLabels: [], sort: 'desc', tooltip: { mode: 'single' },
      legend: { showLegend: true, displayMode: 'table', placement: 'right', values: ['value', 'percent'] } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, noValue: o.empty ?? NO_SOURCE,
      color: o.fallback ? { mode: 'fixed', fixedColor: o.fallback } : { mode: 'palette-classic' } },
      overrides: (o.colors ?? []).map(([name, color]) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } }
}

/** A grid of cells over time (status-history): one row per field of a wide frame, in the order declared, each cell
 * coloured by the threshold steps `o.th`; the value is in the tooltip. */
export function grid(title, target, x, y, w, h, o = {}) {
  return { type: 'status-history', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    timeFrom: o.timeFrom, hideTimeOverride: true, transformations: target.columns ? [declaredOrder([target])] : [],
    options: { showValue: 'never', rowHeight: 0.9, colWidth: 0.92, legend: { showLegend: o.legend !== false, displayMode: 'list', placement: 'bottom' },
      tooltip: { mode: 'single' } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' }, thresholds: o.th,
      custom: { fillOpacity: 100, lineWidth: 0 } }, overrides: [] } }
}

/** Pre-bucketed heatmap: rows (time, <bucket>…), one field per y bucket in the order declared (bottom to top unless
 * `o.top`, which puts the first bucket at the top). Colour from a scheme between o.min and o.max (null: the data's range). */
export function heatmap(title, target, x, y, w, h, o = {}) {
  // The heatmap reads the first field as x and the rest as buckets in field order, so the declared order is restored.
  return { type: 'heatmap', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    timeFrom: o.timeFrom, hideTimeOverride: true, transformations: target.columns ? [declaredOrder([target])] : [],
    options: { calculate: false, cellGap: 1, cellValues: { unit: o.unit ?? 'none', decimals: o.dec ?? 0 }, showValue: 'never',
      // `o.fill`: one hue by opacity, from the background (the minimum) to the full tint (the maximum); otherwise a scheme.
      color: { ...(o.fill ? { mode: 'opacity', fill: o.fill, scheme: 'Blues' } : { mode: 'scheme', scheme: o.scheme, fill: COOL.cat[0] }),
        // `o.exponent`: counts spread over orders of magnitude (a latency histogram), so the sparse buckets still show.
        scale: o.exponent ? 'exponential' : 'linear', exponent: o.exponent ?? 0.5, steps: o.steps ?? 64, reverse: Boolean(o.reverse),
        ...(o.min != null ? { min: o.min } : {}), ...(o.max != null ? { max: o.max } : {}) },
      // Cells at or below `le` are not drawn; margins go negative, so nothing is filtered.
      filterValues: { le: -1e15 }, rowsFrame: { layout: 'auto' }, yAxis: { axisPlacement: 'left', reverse: Boolean(o.top), ...(o.yUnit ? { unit: o.yUnit } : {}) },
      legend: { show: true }, tooltip: { mode: 'single', yHistogram: false, showColorScale: true }, exemplars: { color: C.sub } },
    fieldConfig: { defaults: { noValue: o.empty ?? NO_SOURCE, custom: { scaleDistribution: { type: 'linear' }, hideFrom: { legend: false, tooltip: false, viz: false } } },
      overrides: [] } }
}

/** Grid rows of a spark's number; the rest of its height is the line. */
const SPARK_NUMBER_H = 2
/** One small number with its series drawn underneath (rows: time, value). `calc` reduces the series to the number.
 * Two panels: a stat's own sparkline sits behind its number at any size, so the line is a title-less timeseries below
 * the number. `o.line === false`: the number alone, full height (a single-row answer has no series). */
export function spark(title, target, x, y, w, h, o = {}) {
  const alone = o.line === false
  const number = { type: 'stat', title, description: o.desc ?? '', gridPos: gp(x, y, w, alone ? h : SPARK_NUMBER_H), datasource: target.datasource, targets: [target],
    timeFrom: o.timeFrom, hideTimeOverride: true,
    options: { reduceOptions: { calcs: [o.calc ?? 'lastNotNull'], fields: '', values: false }, orientation: 'auto', textMode: 'value', wideLayout: false,
      colorMode: 'value', graphMode: 'none', justifyMode: 'auto', showPercentChange: false, text: { titleSize: 12, valueSize: 20 } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' },
      thresholds: o.th ?? th([C.txt, null]) }, overrides: [] } }
  if (alone) return number
  const series = marked(structuredClone(target), { planned: target.planned, demo: target.demo, standIn: target.standIn })
  const line = { type: 'timeseries', title: '', description: o.desc ?? '', transparent: true, gridPos: gp(x, y + SPARK_NUMBER_H, w, h - SPARK_NUMBER_H),
    datasource: target.datasource, targets: [series], timeFrom: o.timeFrom, hideTimeOverride: true,
    options: { legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] }, tooltip: { mode: 'single' } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, color: { mode: 'fixed', fixedColor: C.line },
      custom: { drawStyle: 'line', lineInterpolation: 'smooth', lineWidth: 1, fillOpacity: 20, showPoints: 'never', spanNulls: true, axisPlacement: 'hidden' } },
    overrides: [] } }
  return [number, line]
}

/** One display value per row, named by another field of that row. The fields option is matched against display names,
 * and the row name replaces the value field's, so the option selects by elimination: every field except the other
 * columns. The name goes on the value field only (an override), or the other columns would take it too. */
const allBut = (target, valueField) => {
  const others = target.columns.map((c) => c.text).filter((name) => name !== valueField).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return `/^(?!(?:${others.join('|')})$).+$/`
}
const rowName = (valueField, nameField) => ({ matcher: { id: 'byName', options: valueField }, properties: [{ id: 'displayName', value: `\${__data.fields.${nameField}}` }] })

/** LCD bar gauges, one per row: `nameField` names the row, `valueField` fills it against `o.max`. */
export function lcd(title, target, nameField, valueField, x, y, w, h, o = {}) {
  return { type: 'bargauge', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { reduceOptions: { values: true, calcs: [], fields: allBut(target, valueField), limit: 40 }, orientation: 'horizontal', displayMode: 'lcd',
      valueMode: 'color', showUnfilled: true, namePlacement: 'left', minVizHeight: 10, minVizWidth: 8, maxVizHeight: 22, sizing: 'auto', text: { titleSize: 12, valueSize: 14 } },
    fieldConfig: { defaults: { unit: o.unit ?? 'percent', decimals: o.dec ?? 0, min: 0, max: o.max ?? 100,
      noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' }, thresholds: o.th ?? th([C.ok, null], [C.warn, 80], [C.bad, 90]) },
    overrides: [rowName(valueField, nameField)] } }
}

/** Horizontal bars, one per row in the query's order (the first on top), named by `nameField`. Unlike a bar gauge, whose
 * noValue is drawn as a grey bar with the words at its end, an empty result here is the panel's noValue centred:
 * Grafana's barchart hands PanelDataErrorView an empty warning when every frame has no rows, and that view then shows
 * fieldConfig.defaults.noValue. `o.colorBy`: a sibling field whose colour (thresholds or value mappings) fills each bar. */
export function hbars(title, target, nameField, x, y, w, h, o = {}) {
  return { type: 'barchart', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    transformations: [declaredOrder([target])],
    options: { xField: nameField, orientation: 'horizontal', stacking: 'none', showValue: 'always', barWidth: 0.75, groupWidth: 0.7, barRadius: 0,
      xTickLabelRotation: 0, xTickLabelSpacing: 0, xTickLabelMaxLength: o.labelMax ?? 24, fullHighlight: false, tooltip: { mode: 'single' },
      ...(o.colorBy ? { colorByField: o.colorBy } : {}), text: { valueSize: 12 },
      legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, noValue: o.empty ?? NO_SOURCE, color: { mode: 'thresholds' },
      thresholds: o.th ?? th([C.txt, null]), custom: { fillOpacity: 90, lineWidth: 0, gradientMode: 'none', axisPlacement: 'auto',
        ...(o.softMin != null ? { axisSoftMin: o.softMin } : {}), ...(o.softMax != null ? { axisSoftMax: o.softMax } : {}) } },
    overrides: o.overrides ?? [] } }
}

/** Stacked bars over a string x field: one query per series, joined on `xField`. `series`: [[field name, colour]].
 * `o.horizontal`: categories down the left (long names), values at the bar ends; `o.rotate`: vertical bars' label angle. */
export function stackedBars(title, targets, xField, x, y, w, h, series, o = {}) {
  const fields = targets.flatMap((target) => target.columns.filter((c) => c.text !== xField).map((c) => [`${c.text} ${target.refId}`, c.text]))
  return { type: 'barchart', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    transformations: [
      ...(targets.length > 1 ? [{ id: 'joinByField', options: { byField: xField, mode: 'outerTabular' } }] : []),
      { id: 'sortBy', options: { fields: {}, sort: [{ field: xField, desc: false }] } },
      { id: 'organize', options: { excludeByName: {}, indexByName: {}, renameByName: Object.fromEntries(fields) } }],
    options: { xField, orientation: o.horizontal ? 'horizontal' : 'vertical', stacking: 'normal', showValue: o.horizontal ? 'always' : 'never', barWidth: 0.7,
      groupWidth: 0.7, barRadius: 0, xTickLabelRotation: o.rotate ?? 0, xTickLabelSpacing: 0, fullHighlight: false, tooltip: { mode: 'multi' },
      legend: { showLegend: series.length > 1, displayMode: 'list', placement: 'bottom', calcs: [] } },
    fieldConfig: { defaults: { unit: o.unit ?? 'none', decimals: o.dec ?? 0, min: 0, noValue: o.empty ?? NO_SOURCE,
      custom: { fillOpacity: 90, lineWidth: 0, axisSoftMin: 0, axisPlacement: 'auto' } },
      overrides: series.map(([name, color]) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] })) } }
}

/** `links`: [title, dashboard uid], shown as one button each in the page header (no dropdown). */
export function dashboard({ uid, title, panels, time, refresh = '', tag = 'stockvision', links = [] }) {
  // A panel reads its first query's datasource unless it names one.
  panels.forEach((panel, i) => { panel.id = i + 1; panel.datasource ??= panel.targets?.[0]?.datasource })
  return { uid, title, tags: [tag], timezone: 'Asia/Taipei', editable: true, schemaVersion: 39, refresh, time,
    links: links.map(([linkTitle, target]) => ({ title: linkTitle, type: 'link', url: `/d/${target}`, icon: 'dashboard', asDropdown: false, includeVars: false,
      keepTime: false, targetBlank: false, tags: [], tooltip: '' })),
    templating: { list: [] }, panels }
}
