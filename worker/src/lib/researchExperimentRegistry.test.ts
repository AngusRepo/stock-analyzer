import {
  buildResearchReviewPacket,
  listResearchExperiments,
  normalizeResearchExperimentInput,
  putResearchExperiment,
} from './researchExperimentRegistry'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
  store = new Map<string, string>()
  async put(key: string, value: string) {
    this.store.set(key, value)
  }
  async get<T = unknown>(key: string, mode?: string): Promise<T | null> {
    const raw = this.store.get(key)
    if (!raw) return null
    return (mode === 'json' ? JSON.parse(raw) : raw) as T
  }
  async list(opts: { prefix?: string; limit?: number }) {
    const keys = [...this.store.keys()]
      .filter((name) => !opts.prefix || name.startsWith(opts.prefix))
      .slice(0, opts.limit ?? 100)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  }
}

void (async () => {
  const normalized = normalizeResearchExperimentInput({
    hypothesis: '測試突破型策略在多頭 regime 是否改善風險調整後報酬',
    sourceRefs: ['internal:p2-alpha-framework'],
    strategySpecIds: ['breakout_vol_expansion_seed_v1'],
    metrics: ['ic_4w_avg', 'walk_forward_sharpe', 'pbo'],
    followUp: ['run walk-forward dry-run', 'prepare review packet'],
  }, '2026-04-30T01:00:00.000Z')

  assert(normalized.ok, `research experiment should normalize: ${normalized.errors.join(',')}`)
  assert(normalized.record?.approval_gate.can_promote === false, 'research record must not allow direct promote')
  assert(normalized.record?.approval_gate.can_deploy === false, 'research record must not allow deploy')
  assert(normalized.record?.approval_gate.can_trade === false, 'research record must not allow trading')

  const packet = buildResearchReviewPacket(normalized.record!)
  assert(packet.includes('no production retrain'), 'review packet should state production restrictions')

  const kv = new FakeKV()
  await putResearchExperiment(kv as unknown as KVNamespace, normalized.record!)
  const records = await listResearchExperiments(kv as unknown as KVNamespace)
  assert(records.length === 1, 'registry should list persisted research experiments')
  assert(records[0].id === normalized.record!.id, 'registry should preserve experiment id')
  const shadowNormalized = normalizeResearchExperimentInput({
    hypothesis: 'strategy shadow approval metadata should be a first class registry state',
    status: 'approved_for_shadow',
  }, '2026-05-19T00:00:00.000Z')
  assert(shadowNormalized.record?.status === 'approved_for_shadow', 'registry should support approve-shadow state')
  const evidenceNormalized = normalizeResearchExperimentInput({
    hypothesis: 'strategy needs more evidence metadata should be a first class registry state',
    status: 'needs_more_evidence',
  }, '2026-05-19T00:00:00.000Z')
  assert(evidenceNormalized.record?.status === 'needs_more_evidence', 'registry should support request-more-evidence state')
  const paperActiveNormalized = normalizeResearchExperimentInput({
    hypothesis: 'strategy paper active request should be a reviewable registry state',
    status: 'paper_active_requested',
  }, '2026-05-19T00:00:00.000Z')
  assert(paperActiveNormalized.record?.status === 'paper_active_requested', 'registry should support paper-active request state')

  let threw = false
  try {
    assertOwnerCanOwn('research', 'model_promote')
  } catch {
    threw = true
  }
  assert(threw, 'research owner must not own model promotion')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
