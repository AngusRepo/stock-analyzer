/** Reuse the Controller's original committed authority, then fence exact D1
 * sources locally. No second evaluator, caller PASS, stored grant or new owner. */
import { controllerJson } from './controllerClient'
import type { Bindings } from '../types'
import transportPolicy from '../../../ml-controller/services/paired_nav_transport_policy.json'

type Row = Record<string, any>
type Anchor = { sql: string; params: any[]; rows: Row[] }
const tables = new Set(['active8_ensemble_pointer_v1', 'active8_ensemble_artifacts_v1',
  'model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
  'paired_nav_review_records_v1', 'paired_nav_review_parts_v1',
  'paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1'])
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const rowSet = (rows: Row[]) => rows.map(row => JSON.stringify(canonical(row))).sort()
const fail = (): never => { throw new Error('nav_promotion_committed_ml_source_unverified') }
const identity = ['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']

function validateAnchor(a: Anchor) {
  // Closed read-only grammar. Never execute arbitrary SQL received over HTTP.
  const match = /^SELECT (\*|part_no,payload_text) FROM ([a-z0-9_]+)(.*)$/.exec(a.sql)
  const predicate = /^(?: WHERE (?:singleton_id=1|(?:artifact_id|record_id|snapshot_id)=\?|(?:retired_at IS NULL AND )?(?:artifact_id|model_name) IN \(\?(?:,\?)*\)))?(?: ORDER BY part_no)?$/
  if (!match || !tables.has(match[2]) || !predicate.test(match[3]) || !Array.isArray(a.params)
    || (a.sql.match(/\?/g) ?? []).length !== a.params.length || !Array.isArray(a.rows)
    || a.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(k => !/^[a-z][a-z0-9_]*$/.test(k))
      || Object.values(row).some(v => v !== null && !['string', 'number'].includes(typeof v)))) fail()
}

export type NavBaselineFence = { sql: string; params: any[] }
export async function readCommittedNavBaseline(db: D1Database, env: Bindings | undefined,
  formal: Row): Promise<NavBaselineFence> {
  if (!env?.ML_CONTROLLER_SECRET?.trim()) fail()
  const now = Date.now(), started = performance.now()
  const response = await controllerJson<Row>(env!, '/nav/committed-l3-baseline', {
    method: 'POST', timeoutMs: transportPolicy.controller_read_timeout_seconds * 1000,
    jsonBody: Object.fromEntries(identity.map(k => [k, formal[k]])),
  })
  if (response.schema_version !== 'active8-nav-committed-baseline-v1'
    || response.source !== 'original_committed_nav_publication' || response.read_only !== true
    || !identity.every(k => response.formal?.[k] === formal[k])
    || typeof response.observed_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(response.observed_at)
    || !Number.isFinite(Date.parse(response.observed_at)) || Date.parse(response.observed_at) < now
    || Date.parse(response.observed_at) > now + Math.ceil(performance.now() - started)
    || !Number.isFinite(Date.parse(response.published_at))
    || Date.parse(response.published_at) > Date.parse(response.observed_at)
    || !Array.isArray(response.anchors) || !response.anchors.length || response.anchors.length > 64) fail()
  const anchors = response.anchors as Anchor[]
  // The authenticated original reader must have read every authority family.
  const required = new Set(tables)
  const conditions: string[] = [], params: any[] = []
  for (const anchor of anchors) {
    validateAnchor(anchor)
    required.delete(/^SELECT (?:\*|part_no,payload_text) FROM ([a-z0-9_]+)/.exec(anchor.sql)![1])
    const result = await db.prepare(anchor.sql).bind(...anchor.params).all<Row>()
    if (result.success === false || !Array.isArray(result.results) || !same(rowSet(result.results), rowSet(anchor.rows))) fail()
    // NULL-safe field comparison avoids JS/SQLite JSON float formatting drift.
    // Count + membership also fences an originally empty history population.
    conditions.push(`(SELECT COUNT(*) FROM (${anchor.sql}))=${anchor.rows.length}`)
    params.push(...anchor.params)
    if (anchor.rows.length) {
      const columns = Object.keys(anchor.rows[0]).sort()
      if (!columns.length || anchor.rows.some(row => !same(Object.keys(row).sort(), columns))) fail()
      conditions.push(`NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM (${anchor.sql}) s WHERE ${columns.map(k => `s.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')}))`)
      params.push(JSON.stringify(anchor.rows), ...anchor.params)
    }
  }
  if (required.size || params.length > 90) fail() // Leave bindings for downstream pointer/dependency CAS.
  const fence = { sql: conditions.join(' AND '), params }
  await db.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE json('nav_promotion_committed_ml_source_changed') END`)
    .bind(...params).first()
  return fence
}
