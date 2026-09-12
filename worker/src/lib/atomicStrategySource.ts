/** Read-only canonical source owner for Atomic replay. No latest-run fallback. */
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import { screenerCoreSeedUpsertBindings } from './screenerCoreSeedMaterializer'
import { buildScreenerL1MergeItem } from './screenerPostOverlaySeed'
import { replayAtomicStrategySource, replayFrozenCoreSeeds, validateAtomicStrategySource, buildAtomicPolicyContext,
  type AtomicStrategySource, type AtomicShadowReplacement } from './atomicStrategyShadow'

type SourceRow = {
  artifact_id: string; r2_key: string; checksum: string; created_at: string;
  canonical_at: string; schema_version: string; producer_run_id: string; business_date: string;
}

export interface AtomicContinuationRequest {
  definitionChecksum: string
  replacement: AtomicShadowReplacement
  executionSnapshotIds: string[]
}

export function validAtomicContinuations(value: unknown): value is AtomicContinuationRequest[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'definitionChecksum,executionSnapshotIds,replacement'
      || typeof item.definitionChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(item.definitionChecksum) || seen.has(item.definitionChecksum)
      || !Array.isArray(item.executionSnapshotIds) || !item.executionSnapshotIds.length
      || new Set(item.executionSnapshotIds).size !== item.executionSnapshotIds.length
      || item.executionSnapshotIds.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      || !item.replacement || typeof item.replacement !== 'object' || Array.isArray(item.replacement)
      || Object.keys(item.replacement).sort().join(',') !== 'candidateId,candidateVersion,incumbentId,incumbentVersion'
      || Object.values(item.replacement).some(value => typeof value !== 'string' || !value)) return false
    seen.add(item.definitionChecksum)
    return true
  })
}

function sqlUtc(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
}

async function verifiedBody(env: Pick<Bindings, 'ARTIFACTS'>, key: string, checksum: string): Promise<any> {
  if (!key || !/^sha256:[a-f0-9]{64}$/.test(checksum)) throw new Error('atomic_source_artifact_reference_invalid')
  const object = await env.ARTIFACTS?.get(key)
  if (!object) throw new Error('atomic_source_artifact_missing')
  const body = await object.text()
  if (await sha256Text(body) !== checksum) throw new Error('atomic_source_artifact_checksum_mismatch')
  return JSON.parse(body)
}

/** Also used by transport tests; the supplied parent must come from a verified
 * canonical run manifest, not from an untrusted caller's checksum assertion. */
export async function readAtomicSourcePayload(env: Pick<Bindings, 'ARTIFACTS'>, row: SourceRow,
  funnelCapture?: { items?: Record<string, unknown>[] }): Promise<AtomicStrategySource> {
  const envelope = await verifiedBody(env, row.r2_key, row.checksum)
  if (envelope.domain !== 'screener_funnel' || envelope.business_date !== row.business_date
    || envelope.schema_version !== row.schema_version) throw new Error('atomic_source_parent_identity_mismatch')
  let header = envelope.payload
  if (row.schema_version === 'screener-funnel-evidence-index-v1') {
    if (header.storage_mode !== 'chunked_r2_manifest_v1' || header.logical_schema_version !== 'screener-funnel-evidence-v3') {
      throw new Error('atomic_source_parent_schema_invalid')
    }
    header = header.payload_header
  } else if (row.schema_version !== 'screener-funnel-evidence-v3') throw new Error('atomic_source_parent_schema_invalid')
  let source = header?.atomic_strategy_source
  if (source?.schema_version === 'atomic-strategy-source-chunks-v1') {
    if (!Array.isArray(source.fragments) || !source.fragments.length) throw new Error('atomic_source_fragments_missing')
    const parts: string[] = []
    const ids = new Set<string>()
    for (const [index, ref] of source.fragments.entries()) {
      if (ref.status !== 'ready' || ref.domain !== 'screener_funnel_chunk'
        || ref.schema_version !== 'screener-funnel-evidence-chunk-v1'
        || ref.business_date !== row.business_date || ref.producer_run_id !== row.producer_run_id
        || ref.row_count !== 1 || !ref.artifact_id || ids.has(ref.artifact_id)
        || !Number.isFinite(Date.parse(ref.created_at)) || Date.parse(ref.created_at) > Date.parse(row.created_at)) {
        throw new Error('atomic_source_fragment_identity_invalid')
      }
      ids.add(ref.artifact_id)
      const part = await verifiedBody(env, ref.r2_key, ref.checksum)
      const payload = part.payload
      if (part.domain !== ref.domain || part.business_date !== row.business_date || part.schema_version !== ref.schema_version
        || payload?.collection !== 'atomic_strategy_source_json_v1' || payload.storage_mode !== 'chunked_r2_child_v1'
        || payload.logical_domain !== 'screener_funnel' || payload.logical_schema_version !== 'screener-funnel-evidence-v3'
        || payload.chunk_index !== index || payload.chunk_count !== source.fragments.length
        || payload.row_start !== index || payload.row_end_exclusive !== index + 1
        || !Array.isArray(payload.items) || payload.items.length !== 1 || typeof payload.items[0] !== 'string') {
        throw new Error('atomic_source_fragment_coverage_invalid')
      }
      parts.push(payload.items[0])
    }
    const json = parts.join('')
    if (new TextEncoder().encode(json).length !== source.byte_size || await sha256Text(json) !== source.json_checksum) {
      throw new Error('atomic_source_reassembled_checksum_mismatch')
    }
    source = JSON.parse(json)
  }
  if (source?.schema_version !== 'atomic-strategy-source-v1'
    || source.signal_date !== row.business_date || source.producer_run_id !== row.producer_run_id) {
    throw new Error('atomic_source_missing_or_wrong_run')
  }
  if (funnelCapture) funnelCapture.items = await readVerifiedFunnelItems(env, row, envelope.payload)
  return source
}

/** Read ORIGINAL scoring/selection telemetry, not calibrated Core substitutes.
 * Parent checksum binds every child reference; each child hash and contiguous
 * coverage is verified. Do not recompute the old logical JSON checksum with a
 * different property insertion order, or assign historical observation credit.
 */
async function readVerifiedFunnelItems(env: Pick<Bindings, 'ARTIFACTS'>, row: SourceRow,
  payload: any): Promise<Record<string, unknown>[]> {
  let items: unknown[]
  if (row.schema_version === 'screener-funnel-evidence-v3') {
    items = payload?.items
  } else {
    if (!Number.isSafeInteger(payload.item_count) || payload.item_count < 0
      || !Array.isArray(payload.chunks) || !payload.chunks.length) throw new Error('atomic_funnel_manifest_invalid')
    items = []
    const ids = new Set<string>()
    for (const [index, ref] of payload.chunks.entries()) {
      if (ref.chunk_index !== index || !ref.artifact_id || ids.has(ref.artifact_id)
        || ref.schema_version !== 'screener-funnel-evidence-chunk-v1'
        || !Number.isSafeInteger(ref.row_count) || ref.row_count < 0
        || (ref.row_count === 0 && (payload.item_count !== 0 || payload.chunks.length !== 1))
        || ref.row_start !== items.length || ref.row_end_exclusive !== items.length + ref.row_count) {
        throw new Error('atomic_funnel_chunk_reference_invalid')
      }
      ids.add(ref.artifact_id)
      const child = await verifiedBody(env, ref.r2_key, ref.checksum)
      const body = child.payload
      if (child.domain !== 'screener_funnel_chunk' || child.business_date !== row.business_date
        || child.schema_version !== ref.schema_version || body?.storage_mode !== 'chunked_r2_child_v1'
        || body.logical_domain !== 'screener_funnel' || body.logical_schema_version !== 'screener-funnel-evidence-v3'
        || body.collection != null || body.chunk_index !== index || body.chunk_count !== payload.chunks.length
        || body.row_start !== ref.row_start || body.row_end_exclusive !== ref.row_end_exclusive
        || !Array.isArray(body.items) || body.items.length !== ref.row_count) {
        throw new Error('atomic_funnel_chunk_coverage_invalid')
      }
      for (const item of body.items) items.push(item)
    }
    if (items.length !== payload.item_count) throw new Error('atomic_funnel_item_count_mismatch')
  }
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('atomic_funnel_items_invalid')
  }
  return items as Record<string, unknown>[]
}

async function readCanonicalSource(env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  input: { signalDate: string; producerRunId: string; decisionDeadline: string }, includeFunnel = false) {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input.signalDate) || !input.producerRunId
    || !/(Z|[+-]\d{2}:\d{2})$/.test(input.decisionDeadline) || !Number.isFinite(Date.parse(input.decisionDeadline))) {
    throw new Error('atomic_source_request_identity_invalid')
  }
  const db = databaseForDataDomain(env as Bindings, 'ops')
  const row = await db.prepare(`
    SELECT a.artifact_id,a.r2_key,a.checksum,a.created_at,a.schema_version,
           a.producer_run_id,a.business_date,p.canonical_at
      FROM pipeline_runs p JOIN run_artifacts a ON a.artifact_id=p.artifact_id
     WHERE p.run_id=? AND p.business_date=? AND p.domain='screener'
       AND p.canonical_at IS NOT NULL AND p.status IN ('canonical','superseded')
       AND a.producer_run_id=p.run_id AND a.business_date=p.business_date
       AND a.domain='screener_funnel' AND a.status='ready'
       AND a.checksum_verified_at IS NOT NULL AND a.payload_deleted_at IS NULL
  `).bind(input.producerRunId, input.signalDate).first<SourceRow>()
  if (!row) throw new Error('atomic_source_canonical_run_missing')
  const canonical = sqlUtc(row.canonical_at), created = sqlUtc(row.created_at)
  const canonicalUpper = Date.parse(canonical) + (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.canonical_at) ? 999 : 0)
  if (![canonical, created].every(value => /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)))
    || Date.parse(created) > canonicalUpper || canonicalUpper >= Date.parse(input.decisionDeadline)) {
    throw new Error('atomic_source_canonical_time_invalid')
  }
  const funnel: { items?: Record<string, unknown>[] } = {}
  const source = await readAtomicSourcePayload(env, { ...row, created_at: created }, includeFunnel ? funnel : undefined)
  return { source, identity: {
    signalDate: input.signalDate, producerRunId: input.producerRunId,
    artifactCreatedAt: created, decisionDeadline: input.decisionDeadline },
    canonical_artifact_id: row.artifact_id, canonical_artifact_checksum: row.checksum,
    ...(includeFunnel ? { funnel_items: funnel.items! } : {}) }
}

/** Current canonical recipe, not the caller's claimed baseline. No old-date
 * fallback; immutable historical replay retains its separate exact-run path.
 */
export async function readCurrentCanonicalAtomicPolicy(env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  signalDate: string, now: Date) {
  const db = databaseForDataDomain(env as Bindings, 'ops')
  const rows = (await db.prepare(`SELECT run_id FROM pipeline_runs
    WHERE business_date=? AND domain='screener' AND status='canonical' AND canonical_at IS NOT NULL`)
    .bind(signalDate).all<{ run_id: string }>()).results ?? []
  if (rows.length !== 1) throw new Error('atomic_source_current_canonical_ambiguous_or_missing')
  return readCanonicalAtomicPolicy(env, { signalDate, producerRunId: rows[0].run_id,
    decisionDeadline: now.toISOString() })
}

/** Exact original run only. Superseded canonical evidence remains historical
 * evidence; never substitute today's definitions into an old NAV comparison. */
export async function readCanonicalAtomicPolicy(env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  input: { signalDate: string; producerRunId: string; decisionDeadline: string }) {
  const loaded = await readCanonicalSource(env, input)
  await validateAtomicStrategySource(loaded.source, loaded.identity)
  return { ...loaded, policyContext: await buildAtomicPolicyContext(loaded.source) }
}

export async function replayCanonicalAtomicSource(env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  input: { signalDate: string; producerRunId: string; decisionDeadline: string; replacement: AtomicShadowReplacement }) {
  const { source, identity, ...artifact } = await readCanonicalSource(env, input)
  return { ...await replayAtomicStrategySource(source, input.replacement, identity), ...artifact }
}

/** Load the canonical artifact once, retaining the complete structural population.
 * No return-based selection, new market reads, semantic execution or writes. */
export async function replayCanonicalAtomicPopulation(env: Pick<Bindings, 'DB' | 'OPS_DB' | 'ARTIFACTS'>,
  input: { signalDate: string; producerRunId: string; decisionDeadline: string; continuations?: AtomicContinuationRequest[] }) {
  const continuations = input.continuations ?? []
  if (!validAtomicContinuations(continuations)) throw new Error('atomic_source_continuations_invalid')
  const { source, identity, funnel_items, ...artifact } = await readCanonicalSource(env, input, true)
  await validateAtomicStrategySource(source, identity)
  const baseline = await replayFrozenCoreSeeds(source.post_overlay)
  const replacements = []
  // Same role pair can have distinct immutable policies. Retain old registered
  // transfers AND admit the corrected daily-owner comparison without mixing NAV.
  const jobs: Array<{ replacement: AtomicShadowReplacement; definitionChecksum?: string }> = [
    ...source.replacements.map(replacement => ({ replacement })), ...continuations,
  ]
  const completed = new Set<string>()
  for (const { replacement, definitionChecksum } of jobs) {
    const replay = await replayAtomicStrategySource(source, replacement, identity, definitionChecksum)
    if (completed.has(replay.replacement_definition_checksum)) continue
    completed.add(replay.replacement_definition_checksum)
    const post = replay.post_overlay_replay
    replacements.push({ replacement, definition_checksum: replay.replacement_definition_checksum,
      ...(replay.weight_policy_version ? { weight_policy_version: replay.weight_policy_version } : {}),
      runtime_context_checksum: replay.runtime_context_checksum, candidate: replay.candidate_core_replay,
      core_upsert_bindings: replay.candidate_core_replay.status === 'materialized'
        ? replay.candidate_core_replay.rows.map(row => screenerCoreSeedUpsertBindings(source.signal_date, row)) : null,
      recommendation_seed: post.status === 'baseline_matched_candidate_replayed' && post.candidate.status === 'replayed'
        ? { status: 'replayed' as const, final_seed: post.candidate.finalSeed, coarse_queue: replay.candidate.coarseQueue,
          merge_items: post.candidate.finalSeed.map((row, index) => buildScreenerL1MergeItem(row,
            replay.candidate.coarseQueue.find(route => route.symbol === row.symbol), index + 1)) }
        : { status: 'unavailable' as const, reason: 'requires_candidate_post_route_replay' } })
  }
  return { schema_version: 'atomic-canonical-population-v1' as const,
    signal_date: source.signal_date, producer_run_id: source.producer_run_id,
    source_checksum: source.source_checksum, policy_context: await buildAtomicPolicyContext(source), ...artifact,
    source_observed_at: source.observed_at, artifact_created_at: identity.artifactCreatedAt,
    decision_deadline: input.decisionDeadline, baseline, replacements,
    ...(continuations.length ? { continuations: structuredClone(continuations) } : {}),
    core_seed_persistence: source.post_overlay?.observations.core_seed_persistence ?? [],
    screener_seed_source: { schema_version: 'atomic-screener-seed-source-v1' as const,
      source_item_count: funnel_items!.length,
      // Preserve all original scoring and selected seed rows, including symbols
      // absent from the incumbent. This is not a final-picks/Top-K projection.
      items: funnel_items!.filter(item => item.stage === 'scoring' && item.decision === 'pass'
        || ['l1_candidate_seed_after_overlay', 'final_selection'].includes(String(item.stage)) && item.decision === 'selected') },
    source_input_status: source.post_overlay?.input_status ?? 'not_captured',
    production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const }
}
