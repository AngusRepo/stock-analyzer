// node --test infra/grafana/build/rawErrors.test.mjs: the raw-field net catches each way a field gets out (the reviewer's
// synthetic boards) and lets a field that is only tested or parsed through.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rawErrorHits } from './rawErrors.mjs'

const board = (target, extra = {}) => ({ panels: [{ title: 't', targets: [target], ...extra }] })
const rows = (root) => board({ root_selector: root, columns: [{ selector: 'e', text: '原因' }] })
const caught = (name, b) => assert.ok(rawErrorHits(b, 'x').length > 0, `missed: ${name}`)
const passes = (name, b, sanctioned) => assert.deepEqual(rawErrorHits(b, 'x', sanctioned), [], name)

test('a raw field shown through any variable, a bare field, a backtick or $lookup is caught', () => {
  for (const [name, root] of Object.entries({
    '$r.error': "rows.{ 'e': '：' & $r.error }",
    '$v.error (another variable)': "rows.($v := $; { 'e': $v.error })",
    '$.error': "rows.{ 'e': $.error }",
    '$$.rows[0].last_error': "{ 'e': $$.rows[0].last_error }",
    '$x.lastError': "rows.($x := $; { 'e': $x.lastError })",
    '$t.detail (failure-classes detail)': "classes.($t := $; { 'e': $t.detail })",
    '$r.summary': "rows.{ 'e': $r.summary }",
    "$lookup($r, 'error')": "rows.($r := $; { 'e': $lookup($r, 'error') })",
    '$lookup($, "summary")': 'rows.{ "e": $lookup($, "summary") }',
    'backtick field': "rows.{ 'e': `error` }",
    'bare lastError': "rows.{ 'e': lastError }",
    'bare summary': "rows.{ 'e': summary }",
    'bare detail': "rows.{ 'e': detail }",
    "'：'&error (no space)": "rows.{ 'e': '：'&error }",
    '$string($r.error)': "rows.{ 'e': $string($r.error) }",
    '$substring($r.last_error, 0, 40)': "rows.{ 'e': $substring($r.last_error, 0, 40) }",
    'default ?: shows the value': "rows.{ 'e': $r.error ?: '—' }",
    'shown in the else branch': "rows.{ 'e': error_brief ? error_brief : error }",
  })) caught(name, rows(root))
})

test('a raw column, a whole row and a merged row are caught', () => {
  caught('column error', board({ root_selector: 'rows', columns: [{ selector: 'error', text: '錯誤' }] }))
  caught('column a.b.summary', board({ root_selector: 'rows', columns: [{ selector: 'run.summary', text: '摘要' }] }))
  caught('rows with no columns', board({ root_selector: 'rows' }))
  caught('filtered rows with no columns', board({ root_selector: "rows[status = 'error']", columns: [] }))
  caught('no selector and no columns (the response root)', board({ parser: 'backend' }))
  caught('$merge row', rows("rows.$merge([$, { 'x': 1 }])"))
})

test('a link or a transformation naming a raw field is caught; hiding one is not', () => {
  caught('link title', board({ root_selector: 'rows', columns: [{ selector: 'e', text: 'e' }] },
    { fieldConfig: { defaults: { links: [{ title: '${__data.fields["error"]}' }] } } }))
  caught('override link', board({ root_selector: 'x', columns: [{ selector: 'e', text: 'e' }] },
    { fieldConfig: { defaults: {}, overrides: [{ matcher: { id: 'byName', options: '階段' }, properties: [{ id: 'links', value: [{ title: '${__data.fields.summary}' }] }] }] } }))
  caught('organize rename', board({ root_selector: 'x', columns: [{ selector: 'e', text: 'e' }] },
    { transformations: [{ id: 'organize', options: { renameByName: { error: '原因' } } }] }))
  caught('filterFieldsByName include', board({ root_selector: 'x', columns: [{ selector: 'e', text: 'e' }] },
    { transformations: [{ id: 'filterFieldsByName', options: { include: { names: ['stage', 'last_error'] } } }] }))
  passes('organize exclude', board({ root_selector: 'x', columns: [{ selector: 'e', text: 'e' }] },
    { transformations: [{ id: 'organize', options: { excludeByName: { error: true }, renameByName: {}, indexByName: { e: 0 } } }] }))
})

test('a field only tested, parsed or turned into words passes', () => {
  for (const [name, root] of Object.entries({
    'tested by ? :': "rows.{ 'e': error ? 'x' : '' }",
    '$r.error tested': "rows.{ 'e': $r.error_brief ? $r.error_brief : $r.error ? '執行錯誤，細節見 log' : '' }",
    'compared': "rows[$r.summary != '' and last_error = null].{ 'e': stage }",
    'parsed by $match / $contains': "rows.{ 'e': $r.summary ? ($contains($r.summary, /waits? for/) ? $match($r.summary, /until=(\\S+)/).groups[0] : '') : '' }",
    'a status string': "rows[result in ['success', 'error']].{ 'e': 'error' }",
    'a regex': "rows.{ 'e': $replace(stage, /error/, '') }",
    'a comment': "/* the summary is never shown */ rows.{ 'e': stage }",
    'an object path through summary': "[{ 'e': summary.clip_rate, 'f': $$.summary.count }]",
    'the brief fields': "rows.{ 'e': error_brief, 'f': last_error_brief, 'g': $r.error_brief }",
  })) passes(name, rows(root))
  passes('sanctioned words', rows("rows.{ 'e': (detail ? $replace(detail, / lag/, '') : '—') }"), ["(detail ? $replace(detail, / lag/, '') : '—')"])
})

test('a whole row through a named variable, a wildcard, $spread, $sift, $each or a built $lookup key is caught', () => {
  for (const [name, root] of Object.entries({
    '$merge([$r, …]) (named row variable)': "rows.($r := $; $merge([$r, { 'x': 1 }]))",
    '$merge([{…}, $r]) (row not first)': "rows.($r := $; $merge([{ 'x': 1 }, $r]))",
    '$r.* wildcard': "rows.($r := $; { 'e': $join($r.*, ' ') })",
    '$.** descendants': "rows.{ 'e': $join($.**, ' ') }",
    '$spread($)': 'rows.$spread($)',
    '$spread() on the context': 'rows.$spread()',
    '$sift($, …)': "rows.$sift($, function($v, $k) { $k ~> /err/ })",
    '$sift(function) on the context': "rows.$sift(function($v, $k) { $k = 'stage' or $k = 'error' })",
    '$each($, …)': "rows.{ 'e': $join($each($, function($v) { $string($v) }), ' ') }",
    "$lookup($, $f) with $f := 'err' & 'or'": "rows.($f := 'err' & 'or'; { 'e': $lookup($, $f) })",
    "$lookup($r, 'err' & 'or')": "rows.($r := $; { 'e': $lookup($r, 'err' & 'or') })",
    "$lookup($, $k) with $k := 'error'": "rows.($k := 'error'; { 'e': $lookup($, $k) })",
    '$lookup over $keys': "rows.($r := $; $keys($r).{ 'e': $lookup($r, $) })",
  })) caught(name, rows(root))
})

test('a UQL query naming a raw field or projecting nothing, and a simple-parser query with no columns, are caught', () => {
  caught('uql project "error"', board({ parser: 'uql', uql: 'parse-json | scope "rows" | project "stage", "error"' }))
  caught('uql with no project', board({ parser: 'uql', uql: 'parse-json | scope "rows"' }))
  caught('groq naming a field', board({ parser: 'groq', groq: '*[status == "failed"]{stage, last_error}' }))
  caught('simple parser, no root and no columns', board({ parser: 'simple', url: '/v1/chain/alerts' }))
  caught('Infinity datasource with no parser, root or columns', board({ datasource: { type: 'yesoreyeram-infinity-datasource' }, url: '/v1/chain/alerts' }))
  passes('uql projecting the brief', board({ parser: 'uql', uql: 'parse-json | scope "rows" | project "stage", "error_brief"' }))
})

test("the board's own lookups, merges and other datasources pass", () => {
  for (const [name, root] of Object.entries({
    // build.mjs KV drift: each key bound from a literal list.
    'key from a literal list': "rows.($r := $; ['trading:config', 'trading:risk_config'].($k := $string($); { 'time': $r.business_date, 'key': $k, 'status': $lookup($r, $k) }))",
    'a label map': "rows.($label := {\"completed\":\"完成\"}; $s := status; { 'e': $lookup($label, $s) })",
    'a rank function': "($rank := function($r) { ($k := $lookup({\"failed\":1}, $r.kind); $k ? $k : 9) }; rows.{ 'e': $rank($) })",
    'a merge of built objects': "$merge($append({ 'one': 1 }, [{ 'two': 2 }]))",
    'a merge of a sub-object path': "$merge([details.execution_parity, { 'x': 1 }])",
    'multiplication': "rows.{ 'e': $round(ratio * 100) }",
  })) passes(name, rows(root))
  passes('Cloud Monitoring target', { panels: [{ title: 't', datasource: { type: 'stackdriver' }, targets: [{ refId: 'A', queryType: 'timeSeriesList' }] }] })
})

test('a raw field bound to a variable, indexed, stepped into a function, turned into JSON or made a key is caught', () => {
  for (const [name, root] of Object.entries({
    '$e := $r.error, then shown': "rows.($r := $; $e := $r.error; { 'e': $e })",
    '$e := error, then shown': "rows.($e := error; { 'e': $e })",
    '$e := error, $f := $e, then shown': "rows.($e := error; $f := $e; { 'e': $f })",
    'summary[0]': "rows.{ 'e': summary[0] }",
    '$r.error[0]': "rows.($r := $; { 'e': $r.error[0] })",
    '$r.error.$string()': "rows.($r := $; { 'e': $r.error.$string() })",
    '$string($)': "rows.{ 'e': $string($) }",
    '$string($r) of a row alias': "rows.($r := $; { 'e': $string($r) })",
    'object key { error: 1 }': "rows.{ error: 1, 'e': stage }",
    'group key rows{ error: stage }': 'rows{ error: stage }',
  })) caught(name, rows(root))
})

test('a bound field only tested, a bound sub-object, a bound config and $string of a number pass', () => {
  for (const [name, root] of Object.entries({
    '$e := error, only tested': "rows.($e := error; { 'e': $e ? '執行錯誤，細節見 log' : '' })",
    'merge of a bound sub-object': "($c := details.execution_parity; $merge([$c, { 'x': 1 }]))",
    '$each over a bound config': "($cfg := $$.config; $each($cfg, function($v, $k) { { 'k': $k, 'v': $v } }))",
    '$string of a counted variable': "($n := $count(rows); { 'e': $string($n) & ' 站' })",
    '$string of a function parameter': "{ 'e': $map(rows, function($v) { $string($v.count) }) }",
    'an index into a sub-object': "rows.{ 'e': detail[0].code }",
  })) passes(name, rows(root))
})

test('$string of anything but a value is a whole row as JSON', () => {
  for (const [name, root] of Object.entries({
    "a function's parameter": "($f := function($r) { $string($r) }; rows.{ 'e': $f($) })",
    'a collection': "{ 'e': $string(rows) }",
    'an index into a collection': "{ 'e': $string(rows[0]) }",
    'a row alias inside a literal list': "rows.($r := $; ['x'].($k := $string($r); { 'e': $k }))",
    'the context': "rows.{ 'e': $string() }",
    'the response': "{ 'e': $string($$) }",
  })) caught(name, rows(root))
  for (const [name, root] of Object.entries({
    'a field': "rows.{ 'e': $string(lag_days) & ' 日' }",
    'a path to a field': "[{ 'e': $string(summary.recovery_streak) & '／' & $string(thresholds.pass_streak_to_recover) }]",
    'a count': "{ 'e': $string($count(rows[stage = 'l3'])) }",
    'a sum': "($a := $floor($abs($m)); { 'e': $string($a % 60) & 'm', 'f': $string($a) })",
    "a literal list's item": "['a', 'b'].($k := $string($); { 'e': $k })",
    'a summary object bound, read on through': "($v := summary; [{ 'e': $v.count }])",
  })) passes(name, rows(root))
})

test('`&` with a row or a collection on either side is a whole row as JSON', () => {
  for (const [name, root] of Object.entries({
    'the context': "rows.{ 'e': '' & $ }",
    'an index into a collection': "{ 'e': '' & rows[0] }",
    'a row alias': "rows.($r := $; { 'e': 'x' & $r })",
    'a row of the response, on the left': "{ 'e': $$.rows[0] & '' }",
    'a row alias of a filtered collection': "$$.rows[stage = 'a'].($r := $; { 'e': $r & '' })",
    'repeated failures': "{ 'e': '' & repeat_failures[0] }",
    'a repeated failure alias': "repeat_failures.($r := $; { 'e': '' & $r })",
  })) caught(name, rows(root))
  for (const [name, root] of Object.entries({
    'a field': "rows.{ 'e': '業務日 ' & business_date }",
    "a literal list's item": "['a', 'b'].($s := $; { 'e': 'x_' & $s })",
    'an item of a mapped field': "$distinct(rows.business_date).($d := $; { 'e': $d & 'T00:00:00+08:00' })",
    "a row alias's field": "rows.($r := $; { 'e': '第 ' & $string($r.attempt) & ' 次' })",
    "a function's parameter": "($f := function($i) { 'n' & $i }; rows.{ 'e': $f(1) })",
    'a name reused in another scope': "(['a'].($s := $; $s); rows.($s := status; { 'e': $s & '' }))",
    "an item's field": "{ 'e': '最新 ' & rows[0].business_date }",
    "a response row's field, on the left": "{ 'e': $$.rows[0].stage & '' }",
    "a collection's sub-object field": "{ 'e': '狀態 ' & details.execution_parity.status }",
  })) passes(name, rows(root))
})
