// The panels never show a raw error or free text the Worker sends next to its words: they show `error_brief` /
// `last_error_brief` (worker/src/monitoring/errorBrief.ts) and their own words. This finds a query or panel setting that
// would show one; build.mjs --check fails on any hit. It reads the JSONata as text, so it is a net for the usual ways a
// field gets out (a variable's field, a bare field, $lookup, a column, a whole row, a link, a transformation), not a parser.
//
// Known forms it does not catch (none is in a board; a reviewer reads a new selector for them): a descendant path
// (`**.error`), a parenthesized or sorted step before the field (`(rows).error`, `rows^(stage).error`), a quoted path step
// (`$."error"`), a chained $lookup (`$ ~> $lookup('error')`), a field name built from parts read off a path
// (`$lookup(rows[0], 'err' & 'or')`), a key variable bound twice (`$k := 'stage'; $k := 'error'`), `$eval`, a regex
// match's text (`$match(error, /.+/).match`), a comment inside a path (`$r/**/.error`), and a row bound from a path
// for $merge / $each (`$r := rows[0]; $merge([$r, …])`: a variable bound to any path reads as a sub-object, so
// `$c := details.x; $merge([$c, …])` passes). Through $string or `&`: a call that returns rows
// (`$string($reverse(rows))`, `$string(rows ~> $reverse())`), an object outside the known collections (`$string(job)`),
// and a variable bound twice (`$v := 1; $v := rows[0]; $string($v)`). Through `&` also: an alias bound inside an object
// value (`rows.{ 'e': ($r := $; '' & $r) }`), a collection held in a variable (`$all := $sort(rows, …); $all.($r := $; …)`),
// an alias bound to another (`$q := $r`), a parenthesized side (`'' & ($)`) and a function's parameter.
// Known false alarms: a plain path with no columns (`rows.stage`) reads as whole rows, give it columns; $string of a
// function's parameter reads as a row even when the caller passes a number (`function($n) { $string($n) }`), turn the
// number into text where it is computed instead. `$` beside `&` reads as a row even when a literal list or a list of
// values is mapped (`$distinct(rows.business_date).('業務日 ' & $)`), bind it to a name (`($d := $; '業務日 ' & $d)`).

/** The Worker's raw fields: errors (snake and camel case) and free text (ticket detail, run summary). */
export const RAW_FIELDS = ['error', 'last_error', 'lastError', 'detail', 'summary']
const NAME = `(?:${RAW_FIELDS.join('|')})`
/** The field is shown unless a path goes on through it (`summary.clip_rate`, `$$.summary.count`, `detail[0].x`): an
 * index or a function step shows it (`summary[0]`, `$r.error[0]`, `$r.error.$string()`). */
const SHOWN_END = `(?!\\w)(?!(?:\\[[^\\[\\]]*\\])*\\s*\\.\\s*[A-Za-z_\`])`
/** A variable's or path's field: $r.error, $v.detail, $.summary, $$.rows[0].last_error, rows.lastError. */
const DOT = new RegExp(`(?:\\$\\$?\\w*|[A-Za-z_]\\w*)(?:\\[[^\\[\\]]*\\])*(?:\\.\\w+(?:\\[[^\\[\\]]*\\])*)*\\.${NAME}${SHOWN_END}`, 'g')
/** A bare field in a row's context (rows.{ 'x': error }), or its backtick form; as an object or group key it is shown
 * too (`rows.{ error: 1 }`, `rows{ error: stage }` make its text a column name). Not inside a string or a regex. */
const BARE = new RegExp(`(?<![\\w$.'"/\`])${NAME}(?!['"\`/])${SHOWN_END}|\`${NAME}\``, 'g')
/** $lookup(x, 'error'): a field read by name. */
const LOOKUP = new RegExp(`\\$lookup\\(\\s*[^,()]+,\\s*['"]${NAME}['"]\\s*\\)`, 'g')
/** Only tested, never shown: the condition of `? :`, a comparison, or the argument of a test or a parse. `?:` (default)
 * and `??` (coalesce) show the value. */
const TESTED_AFTER = /^\s*(?:\?(?![:?])|!=|=|<|>|\band\b|\bor\b|\bin\b)/
const TESTED_BEFORE = /(?:\$(?:exists|boolean|not|contains|match|type|length|count)\(\s*|(?:!=|<=|>=|(?<!:)=|<|>|\band|\bor)\s*)$/
/** A field bound to a variable (`$e := $r.error`) is shown when the variable is: unless each later use is only tested
 * (`$e ? … : …`) or a path on through it (`$v := summary; $v.count` reads the summary object's count). `depth` follows
 * a variable bound to another. */
const PATH_ON = /^(?:\[[^\[\]]*\])*\s*\.\s*[A-Za-z_`]/
function isShown(text, index, length, depth = 0) {
  if (TESTED_AFTER.test(text.slice(index + length)) || TESTED_BEFORE.test(text.slice(Math.max(0, index - 80), index))) return false
  const bound = /\$(\w+)\s*:=\s*$/.exec(text.slice(Math.max(0, index - 80), index))
  if (!bound) return true
  if (depth > 3) return true
  const rest = index + length
  return [...text.slice(rest).matchAll(new RegExp(`\\$${bound[1]}(?!\\w)(?!\\s*:=)`, 'g'))]
    .filter((use) => !PATH_ON.test(text.slice(rest + use.index + use[0].length)))
    .some((use) => isShown(text, rest + use.index, use[0].length, depth + 1))
}
/** Text that turns a raw field into words before it is shown (build.mjs passes each, e.g. READINESS_DETAIL('detail'):
 * a readiness detail is the Worker's own description, its codes read as words). */
/** Comments, strings and regex arguments are text, not fields ('error' in `result = 'error'`, /error/ in $match). */
const LITERALS = [/\/\*[\s\S]*?\*\//g, /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, /(?<=[(,]\s*)\/(?:[^/\\\n]|\\.)+\/[im]*/g]
const unsanctioned = (selector, sanctioned) => sanctioned.reduce((text, words) => text.split(words).join(' '), selector)
const uncommented = (selector, sanctioned) => unsanctioned(selector, sanctioned).replace(LITERALS[0], ' ')
const blank = (selector, sanctioned) => LITERALS.reduce((text, literal) => text.replace(literal, (m) => m.startsWith('/*') ? ' ' : m[0] === '/' ? '/ /' : "''"),
  unsanctioned(selector, sanctioned))
function shown(selector, sanctioned) {
  // Each match is read in the text it was found in: a $lookup's name is a literal, the fields are not.
  const raw = unsanctioned(selector, sanctioned)
  const text = blank(selector, sanctioned)
  return [...[DOT, BARE].flatMap((pattern) => [...text.matchAll(pattern)].map((m) => [text, m])), ...[...raw.matchAll(LOOKUP)].map((m) => [raw, m])]
    .filter(([within, m]) => isShown(within, m.index, m[0].length))
    .map(([within, m]) => `…${within.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10).replace(/\s+/g, ' ')}…`)
}
const FIELD_LAST = new RegExp(`(?:^|\\.)${NAME}$`)
/** A whole row: a plain path (no object built, no function) with no columns hands Grafana every field the row has. */
const WHOLE_ROW = /^\s*[\w$.]*(?:\[[^\]]*\])?\s*$/

/** A variable that may hold a row: `$`, `$$`, a variable bound to one of them (`$r := $`), or one not bound in the
 * selector (a function's parameter). A variable bound to anything else holds what it was bound to: `$label := {…}`,
 * `$rank := function(…)`, `$c := details.execution_parity`, `$cfg := $$.config`. */
function isRowVar(text, name) {
  if (name === '$' || name === '$$') return true
  const bound = new RegExp(`\\${name}(?!\\w)\\s*:=\\s*(\\$\\$?\\s*[;)])?`).exec(text)
  return bound ? bound[1] !== undefined : true
}
/** The top-level comma-separated parts of the text from `open` (just past a `(` or `[`) to its closing bracket. */
function parts(text, open) {
  const out = []; let depth = 0; let start = open
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) { if (depth-- === 0) { out.push(text.slice(start, i).trim()); break } }
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1 }
  }
  return out
}
const VAR = /^\$\$?\w*$/
/** A variable or a path, with indexes: `$`, `$r.attempt`, `rows[0]`, `business_date`. */
const OPERAND = `(?:\\$\\$?\\w*|[A-Za-z_]\\w*)(?:\\[[^\\[\\]]*\\])*(?:\\.\\w+(?:\\[[^\\[\\]]*\\])*)*`
/** What `$name := …` binds, up to its `;` or the bracket that closes it; null when the selector does not bind it (a
 * function's parameter). */
function boundExpr(text, name) {
  const m = new RegExp(`\\${name}(?!\\w)\\s*:=\\s*`).exec(text)
  if (!m) return null
  let depth = 0
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) { if (depth-- === 0) return text.slice(m.index + m[0].length, i).trim() }
    else if (c === ';' && depth === 0) return text.slice(m.index + m[0].length, i).trim()
  }
  return text.slice(m.index + m[0].length).trim()
}
/** Where the binding of `name` nearest before `at` starts (a name reused in another scope, `$s := $` and `$s := $ds($r)`). */
function lastBinding(text, name, at) {
  const all = [...text.slice(0, at).matchAll(new RegExp(`\\${name}(?!\\w)\\s*:=`, 'g'))]
  return all.length ? all.at(-1).index : 0
}
/** A response's collections: a bare name of one is many rows, not a value (`$string(rows)`). */
const COLLECTIONS = new Set(['rows', 'checks', 'items', 'models', 'stages', 'runs', 'alerts', 'classes', 'tickets', 'jobs', 'entries',
  'records', 'data', 'details', 'thresholds', 'counts', 'arms', 'chains', 'repeat_failures', 'current', 'latest_arm_statistics'])
/** `$string(x)` turns a row into its JSON, so its argument must be a value: a literal, a sum, a call (`$count(…)`,
 * `$floor($a / 60)`), a path ending in a field that is no raw field and no collection (`lag_days`, `$r.attempt`,
 * `summary.recovery_streak`), or a variable bound to one of these (`$done := $count(…)`). `$`, `$$`, a row alias, a
 * function's parameter (`function($r) { $string($r) }`), a collection (`rows`) or an index (`rows[0]`) is a row.
 * `text` has its literals blanked. */
function isScalar(text, arg, depth = 0) {
  const a = arg.trim()
  if (a === '' || depth > 3) return false
  if (/^(?:''|-?\d+(?:\.\d+)?|true|false|null)$/.test(a)) return true
  if (/^\$\w+\(/.test(a)) return true
  // An operator outside any bracket makes it a sum, a concatenation or a comparison.
  if (/[-+*/%&<>=]|\band\b|\bor\b/.test(a.replace(/\([^()]*\)|\[[^\[\]]*\]/g, ''))) return true
  if (VAR.test(a)) {
    if (a === '$' || a === '$$') return false
    const expr = boundExpr(text, a)
    return expr !== null && !VAR.test(expr) && isScalar(text, expr, depth + 1)
  }
  const path = /^(?:\$\$?\w*|[A-Za-z_]\w*)(?:\[[^\[\]]*\])*(?:\.\w+(?:\[[^\[\]]*\])*)*$/.exec(a)
  if (!path || a.endsWith(']')) return false
  const last = a.split('.').at(-1)
  return !RAW_FIELDS.includes(last) && !COLLECTIONS.has(last)
}
/** `$`, `$$`, a variable bound to one of them, or a collection or one of its items (`rows`, `rows[0]`, `$$.rows[0]`). */
function isRowOrCollection(text, operand, at) {
  if (operand === '$' || operand === '$$') return true
  if (VAR.test(operand)) {
    // A row alias when it is bound to `$` while mapping a collection (`rows.($r := $; …)`, `$$.rows[x].($r := $; …)`);
    // mapping anything else (a literal list, `$distinct(rows.business_date)`) binds the text or number it holds.
    const from = lastBinding(text, operand, at)
    const mapped = /(?:^|[^\w.$])(?:\$\$?\s*\.\s*)?(\w+)(?:\[[^\[\]]*\])*\s*\.\s*\(\s*$/.exec(text.slice(Math.max(0, from - 400), from))
    return ['$', '$$'].includes(boundExpr(text.slice(from), operand)) && COLLECTIONS.has(mapped?.[1])
  }
  // A path is many rows or one when it stops on a collection or an item of it (`rows`, `$$.rows[0]`); a step after it
  // reads a field or a sub-object (`rows[0].business_date`, `details.execution_parity.status`).
  return COLLECTIONS.has(operand.replace(/\[[^\[\]]*\]/g, '').split('.').at(-1))
}
/** A whole row's values in one value: merged into an object ($merge([$r, {…}])), spread, sifted or walked with $each
 * (on a row, or on the context when called with a function or nothing: rows.$each(function($v) {…})), turned into
 * JSON ($string($)), or every field by wildcard ($r.*, $.**, { 'e': * }). `text` has its literals and comments blanked. */
function wholeRowValues(text) {
  const hits = []
  for (const m of text.matchAll(/\$merge\(\s*/g)) {
    const [arg] = parts(text, m.index + m[0].length)
    const items = arg?.startsWith('[') ? parts(arg, 1) : [arg]
    if (items.some((item) => VAR.test(item ?? '') && isRowVar(text, item))) hits.push('a whole row merged into the output')
  }
  for (const m of text.matchAll(/\$(spread|sift|each)\(\s*/g)) {
    const [first = ''] = parts(text, m.index + m[0].length)
    if (first === '' || first.startsWith('function') || (VAR.test(first) && isRowVar(text, first))) hits.push(`a whole row through $${m[1]}`)
  }
  for (const m of text.matchAll(/\$string\(\s*/g)) {
    const [first = ''] = parts(text, m.index + m[0].length)
    const listItem = first === '$' && /\[\s*''(?:\s*,\s*'')*\s*\]\s*\.\s*\(\s*\$\w+\s*:=\s*$/.test(text.slice(Math.max(0, m.index - 400), m.index))
    if (!listItem && !isScalar(text, first)) hits.push('a whole row as JSON through $string')
  }
  // `&` turns an object into its JSON just as $string does: a side that is a row (`'' & $`, `'' & $r` with `$r := $`)
  // or a collection (`'' & rows`, `'' & rows[0]`). A function's parameter or a match group is taken as the text it holds.
  for (const m of text.matchAll(/&/g)) {
    const after = new RegExp(`^\\s*(${OPERAND})(?![\\w$])(?!\\s*\\()`).exec(text.slice(m.index + 1))
    const before = new RegExp(`(${OPERAND})\\s*$`).exec(text.slice(0, m.index))
    for (const operand of [after?.[1], before?.[1]]) if (operand && isRowOrCollection(text, operand, m.index)) hits.push(`a whole row as JSON through & (${operand})`)
  }
  if (/(?:[\w$)\]])\s*\.\s*\*|[:(,[]\s*\*{1,2}\s*[,)}\]]/.test(text)) hits.push('every field by wildcard')
  return hits
}
/** $lookup(row, key) with a key that is not a literal can read any field ($f := 'err' & 'or'; $lookup($, $f)). It
 * passes when the key is a variable bound to literals none of which is a raw field: `$k := 'x'`, or each of a literal
 * list (`['trading:config', 'trading:risk_config'].($k := $string($); … $lookup($r, $k))`). `text` keeps its literals. */
const LIT = `(?:'[^'\\\\]*'|"[^"\\\\]*")`
const unquote = (literal) => literal.slice(1, -1)
function keyLiterals(text, key) {
  if (!VAR.test(key)) return null
  const k = `\\${key}(?!\\w)`
  const one = new RegExp(`${k}\\s*:=\\s*(${LIT})\\s*[;)]`).exec(text)
  if (one) return [unquote(one[1])]
  const list = new RegExp(`\\[\\s*(${LIT}(?:\\s*,\\s*${LIT})*)\\s*\\]\\s*\\.\\s*\\(\\s*${k}\\s*:=\\s*(?:\\$string\\(\\s*\\$\\s*\\)|\\$)\\s*;`).exec(text)
  return list ? [...list[1].matchAll(new RegExp(LIT, 'g'))].map((m) => unquote(m[0])) : null
}
function dynamicLookups(text) {
  return [...text.matchAll(/\$lookup\(\s*/g)].flatMap((m) => {
    const [row = '', key = ''] = parts(text, m.index + m[0].length)
    if (new RegExp(`^${LIT}$`).test(key) || !VAR.test(row) || !isRowVar(text, row)) return []
    const keys = keyLiterals(text, key)
    return keys && !keys.some((name) => RAW_FIELDS.includes(name)) ? [] : [`$lookup(${row}, ${key}) reads a field by a name it builds`]
  })
}

/** A UQL or GROQ query (Infinity's other parsers): a raw field named anywhere in it (`project "error"`); a UQL query
 * with no `project` hands over every field of every row. */
const QUERY_FIELD = new RegExp(`(?<![\\w.$])["'\`]?${NAME}["'\`]?(?![\\w])`)
function queryHits(parser, query = '') {
  return [...(QUERY_FIELD.test(query) ? [`the ${parser.toUpperCase()} query names a raw field`] : []),
    ...(parser === 'uql' && !/\bproject\b/i.test(query) ? ['the UQL query projects no columns (whole rows)'] : [])]
}

/** A link or a transformation naming a raw field: `${__data.fields["error"]}`, `__data.fields.summary`, organize's
 * renameByName / indexByName, filterFieldsByName's include. Hiding it (excludeByName: true) is fine. */
const LINK_FIELD = new RegExp(`__data\\.fields(?:\\.${NAME}\\b|\\[\\s*\\\\?["']${NAME}\\\\?["']\\s*\\])`)
const QUOTED_FIELD = new RegExp(`"${NAME}"`)
/** An Infinity query, whatever its parser (backend, simple, uql, groq): the panel's other datasources (Cloud Monitoring,
 * BigQuery) carry no Worker row. */
const INFINITY = 'yesoreyeram-infinity-datasource'
const isInfinityQuery = (target, panel) => (target.datasource ?? panel.datasource)?.type === INFINITY
  || ['parser', 'root_selector', 'columns', 'uql', 'groq'].some((key) => target[key] !== undefined)

/** `where: message` for every place a board would show a raw field. */
export function rawErrorHits(board, where, sanctioned = []) {
  return (board.panels ?? []).flatMap((panel) => {
    const at = `${where} ${panel.title || panel.type}`
    const hits = (panel.targets ?? []).flatMap((target) => {
      if (!isInfinityQuery(target, panel)) return []
      if (target.parser === 'uql' || target.parser === 'groq') return queryHits(target.parser, target[target.parser]).map((text) => `${at}: ${text}`)
      const selector = target.root_selector ?? ''
      const columns = target.columns ?? []
      return [
        ...shown(selector, sanctioned).map((text) => `${at}: shows ${text}`),
        ...columns.filter((column) => FIELD_LAST.test(column.selector ?? '')).map((column) => `${at}: column ${column.selector}`),
        ...(!columns.length && WHOLE_ROW.test(selector) ? [`${at}: whole rows with no columns (${selector || 'the response root'})`] : []),
        ...[...wholeRowValues(blank(selector, sanctioned)), ...dynamicLookups(uncommented(selector, sanctioned))].map((text) => `${at}: ${text}`),
      ]
    })
    const settings = JSON.stringify([panel.fieldConfig ?? {}, panel.options ?? {}])
    if (LINK_FIELD.test(settings)) hits.push(`${at}: a link shows a raw field`)
    for (const transformation of panel.transformations ?? []) {
      const options = structuredClone(transformation.options ?? {})
      for (const [name, hidden] of Object.entries(options.excludeByName ?? {})) if (hidden === true) delete options.excludeByName[name]
      if (transformation.id === 'filterFieldsByName' && options.exclude) delete options.exclude
      if (QUOTED_FIELD.test(JSON.stringify(options))) hits.push(`${at}: transformation ${transformation.id} names a raw field`)
    }
    return hits
  })
}
