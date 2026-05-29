import {
  ensureMetaLearningResearchRegistry,
  buildMetaLearningEvidenceMatrix,
  buildMetaLearningDecisionPacket,
  listMetaLearningTracks,
  validateMetaLearningTrack,
} from './metaLearningResearchTrack'
import type { ResearchExperimentRecord } from './researchExperimentRegistry'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const baseExperiment: ResearchExperimentRecord = {
  id: 'exp-neuralucb-counterfactual',
  version: 'research-registry-v1',
  status: 'queued',
  hypothesis: 'Run NeuralUCB counterfactual decisions beside LinUCB and compare reward',
  source_refs: ['p9-meta-learning'],
  strategy_spec_ids: ['meta_learning_counterfactual_v1'],
  data_slice: { start_date: '2026-04-01', end_date: '2026-05-07' },
  metrics: ['counterfactual_reward', 'pbo', 'regime_slice'],
  follow_up: ['run counterfactual replay'],
  approval_gate: {
    can_research: true,
    can_generate_patch_or_report: true,
    can_retrain_prod: false,
    can_promote: false,
    can_deploy: false,
    can_trade: false,
  },
  created_at: '2026-05-08T00:00:00.000Z',
  updated_at: '2026-05-08T00:00:00.000Z',
}

{
  const result = validateMetaLearningTrack()
  assert(result.ok, `meta learning track should be valid: ${result.errors.join(',')}`)
}

{
  const tracks = listMetaLearningTracks([baseExperiment])
  const ids = tracks.map((track) => track.id)
  assert(ids.join(',') === 'LinUCB,NeuralUCB,NeuralTS,OnlinePortfolioBandit,NeuCB', 'track order should be stable')
  assert(tracks.every((track) => track.can_vote_alpha === false), 'meta learners must not vote as alpha models')
  assert(
    tracks.filter((track) => track.can_influence_production).map((track) => track.id).join(',') === 'LinUCB,OnlinePortfolioBandit',
    'LinUCB and OnlinePortfolioBandit may influence production only through their governed meta/allocation roles',
  )
  assert(
    tracks.find((track) => track.id === 'NeuralUCB')?.registered_experiment_ids.includes('exp-neuralucb-counterfactual'),
    'NeuralUCB should link matching experiment registry records',
  )
  assert(
    tracks.find((track) => track.id === 'OnlinePortfolioBandit')?.stage === 'production_controller',
    'portfolio bandit should be the governed allocator-controller lane',
  )
  assert(tracks.find((track) => track.id === 'NeuCB')?.stage === 'research_only', 'NeuCB should stay research-only')
  assert(
    tracks.find((track) => track.id === 'OnlinePortfolioBandit')?.experiment_template.metrics.includes('partial_fill_replay'),
    'portfolio bandit template should require execution realism evidence',
  )
  assert(
    tracks.find((track) => track.id === 'NeuCB')?.experiment_template.metrics.includes('cost_profile'),
    'NeuCB template should include cost profile benchmark evidence',
  )
}

{
  const packet = buildMetaLearningDecisionPacket([baseExperiment])
  assert(packet.includes('LinUCB remains the interpretable meta baseline'), 'packet should clarify LinUCB baseline')
  assert(packet.includes('OnlinePortfolioBandit controls allocator knobs'), 'packet should clarify portfolio bandit allocator-controller scope')
}

{
  const tracks = listMetaLearningTracks([baseExperiment])
  const matrix = buildMetaLearningEvidenceMatrix(tracks, {
    rewardLedger: [
      {
        policy_id: 'LinUCB',
        arm_id: 'feature_family',
        context_hash: 'bull:otc',
        samples: 42,
        reward_mean: 0.018,
        updated_at: '2026-05-08T00:00:00.000Z',
      },
      {
        policy_id: 'OnlinePortfolioBandit',
        arm_id: 'conservative_diversified',
        context_hash: 'bull:paper_active',
        samples: 35,
        reward_mean: 0.012,
        updated_at: '2026-05-08T00:00:00.000Z',
      },
    ],
    shadowDecisions: [
      {
        policy_id: 'NeuralUCB',
        samples: 15,
        counterfactual_reward_mean: 0.011,
        latest_decision_at: '2026-05-08T00:00:00.000Z',
      },
    ],
  })

  const linucb = matrix.find((row) => row.id === 'LinUCB')
  const neural = matrix.find((row) => row.id === 'NeuralUCB')
  const portfolio = matrix.find((row) => row.id === 'OnlinePortfolioBandit')
  assert(linucb?.reward_ledger_status === 'ready', 'LinUCB should become ready when reward ledger has samples')
  assert(neural?.shadow_status === 'partial', 'NeuralUCB should show partial counterfactual evidence when decisions exist')
  assert(portfolio?.reward_ledger_status === 'ready', 'portfolio bandit should use warm-start reward ledger evidence')
  assert(portfolio?.evidence_status === 'partial', 'portfolio bandit should be partial until controller experiment evidence exists')
}

async function assertEnsureMetaLearningResearchRegistry(): Promise<void> {
  const storage = new Map<string, string>()
  const kv = {
    async list({ prefix }: { prefix: string; limit?: number }) {
      return {
        keys: [...storage.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      }
    },
    async get(name: string) {
      const raw = storage.get(name)
      return raw ? JSON.parse(raw) : null
    },
    async put(name: string, value: string) {
      storage.set(name, value)
    },
  } as unknown as KVNamespace

  const first = await ensureMetaLearningResearchRegistry(kv, '2026-05-08T00:00:00.000Z')
  const second = await ensureMetaLearningResearchRegistry(kv, '2026-05-08T00:00:00.000Z')
  assert(first.created.length === 5, 'meta learning registry closure should seed all five track experiments')
  assert(second.created.length === 0, 'meta learning registry closure must be idempotent')
  const tracks = listMetaLearningTracks(await Promise.all([...storage.values()].map((raw) => JSON.parse(raw))))
  assert(
    tracks.every((track) => track.registered_experiment_ids.length > 0),
    'all meta learning tracks should link to seeded experiment registry records',
  )
}

void assertEnsureMetaLearningResearchRegistry()
