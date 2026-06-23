import { runLinUcbMultiplierReplay } from './linucbMultiplierReplayRunner'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function makeFakeDb(rows: any[] = []) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: rows }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

void (async () => {
  const writes: Array<{ key: string; value: string }> = []
  const kv = {
    async put(key: string, value: string) {
      writes.push({ key, value })
    },
  } as unknown as KVNamespace

  const originalFetch = globalThis.fetch
  let fetchUrl = ''
  let fetchHeaders: Headers
  let fetchBody: any
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchUrl = String(input)
    fetchHeaders = new Headers(init?.headers)
    fetchBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({
      status: 'fail',
      allowed_use: 'research_only',
      prepared_rows: 9,
      candidate_count: 2,
      best_candidate: {
        bandit_loss_thresh_high: 0.6,
        bandit_loss_thresh_med: 0.4,
        bandit_max_mult_low: 2.5,
      },
      adaptive_params_candidate: {
        schema_version: 'adaptive-params-candidate-v1',
        candidate_type: 'linucb_bandit_l2_constants',
        status: 'candidate_requires_approval',
        approved: false,
        mutation_allowed: false,
        production_effect: false,
        proposed_production_effect: 'capped_production_effect',
        allowed_target: 'ml:adaptive_params.bandit_l2_constants',
        adaptive_params_patch: {
          bandit_loss_thresh_high: 0.6,
          bandit_loss_thresh_med: 0.4,
          bandit_max_mult_low: 2.5,
        },
      },
      allocator_policy_candidate: {
        schema_version: 'allocator-learning-policy-candidate-v1',
        candidate_type: 'linucb_model_learning_weight_multipliers',
        status: 'candidate_requires_approval',
        approved: false,
        mutation_allowed: false,
        production_effect: false,
        proposed_production_effect: 'learning_weight_only',
        allowed_target: 'ml:adaptive_params.model_allocator.learning_weight_policy',
        model_learning_multipliers: {
          LightGBM: 1.1,
        },
      },
      gates: [{ name: 'min_decisions', passed: false }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await runLinUcbMultiplierReplay({
      DB: makeFakeDb([
        { date: '2026-06-05', stock_id: '2330', symbol: '2330', model_name: 'LightGBM', direction_correct: 1, actual_return_pct: 0.03 },
      ]),
      KV: kv,
      ML_SERVICE_URL: 'https://ml.example.com/',
      ML_SERVICE_SECRET: 'service-secret',
    }, {
      startDate: '2026-05-01',
      endDate: '2026-06-08',
      limit: 5,
      minDecisions: 12,
      maxGridEvals: 24,
      recentLossWindow: 7,
      persist: true,
    })

    assert(fetchUrl === 'https://ml.example.com/meta-learning/linucb-multiplier-replay', 'runner must call LinUCB multiplier replay endpoint')
    assert(fetchHeaders.get('X-Service-Token') === 'service-secret', 'runner must pass service token when configured')
    assert(fetchBody.rows.length === 1, 'runner must send verified active-9 rows')
    assert(fetchBody.min_decisions === 12, 'runner must pass bounded min_decisions')
    assert(fetchBody.max_grid_evals === 24, 'runner must pass bounded max_grid_evals')
    assert(fetchBody.recent_loss_window === 7, 'runner must pass bounded recent_loss_window')
    assert(result.mode === 'persisted_evidence', 'persisted mode should be explicit')
    assert(result.production_effect === false, 'replay must be marked non-production')
    assert(result.mutation_allowed === false, 'replay must be marked mutation-forbidden')
    assert(result.real_trading_allowed === false, 'replay must be marked real-trading forbidden')
    assert(result.adaptive_params_candidate?.status === 'candidate_requires_approval', 'LinUCB replay evidence must preserve adaptive params candidate packet')
    assert(result.allocator_policy_candidate?.candidate_type === 'linucb_model_learning_weight_multipliers', 'LinUCB replay must preserve allocator learning-weight candidate packet')
    assert(result.summary.includes('adaptive_candidate=candidate_requires_approval'), 'summary must expose candidate status for OBS triage')
    assert(result.summary.includes('allocator_candidate=candidate_requires_approval'), 'summary must expose allocator learning candidate status for OBS triage')
    assert(writes.some((row) => row.key === 'meta:linucb_multiplier_replay:latest'), 'persisted replay must write latest evidence key')
    assert(writes.some((row) => row.key === 'meta:linucb_multiplier_replay:2026-06-08'), 'persisted replay must write date evidence key')
    assert(writes.every((row) => row.key.startsWith('meta:linucb_multiplier_replay:')), 'LinUCB multiplier replay must only persist evidence keys')
    assert(writes.some((row) => JSON.parse(row.value).adaptive_params_candidate?.candidate_type === 'linucb_bandit_l2_constants'), 'persisted replay evidence must include adaptive params candidate packet')
    assert(writes.some((row) => JSON.parse(row.value).allocator_policy_candidate?.candidate_type === 'linucb_model_learning_weight_multipliers'), 'persisted replay evidence must include allocator learning candidate packet')
    assert(!writes.some((row) => row.key === 'trading:config' || row.key === 'ml:adaptive_params'), 'LinUCB multiplier replay must not mutate live config keys')
  } finally {
    globalThis.fetch = originalFetch
  }
})()
