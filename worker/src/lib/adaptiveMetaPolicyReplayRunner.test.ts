import {
  listAdaptiveMetaPolicyReplayRows,
  runAdaptiveMetaPolicyReplay,
} from './adaptiveMetaPolicyReplayRunner'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function makeFakeDb(rows: any[] = []) {
  const state: { sql?: string; binds?: unknown[] } = {}
  const db = {
    prepare(sql: string) {
      state.sql = sql
      return {
        bind(...binds: unknown[]) {
          state.binds = binds
          return {
            async all() {
              return { results: rows }
            },
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, state }
}

void (async () => {
  {
    const { db, state } = makeFakeDb([{ date: '2026-06-05', model_name: 'LightGBM' }])
    const rows = await listAdaptiveMetaPolicyReplayRows(db, {
      startDate: '2026-05-01',
      endDate: '2026-06-08',
      limit: 12,
    })

    assert(rows.length === 1, 'list runner should return D1 rows')
    assert(state.sql?.includes('p.verified_at IS NOT NULL'), 'replay source must require verified predictions')
    assert(state.sql?.includes('p.actual_return_pct IS NOT NULL'), 'replay source must require realized returns')
    assert(state.sql?.includes("json_extract(p.forecast_data, '$.rank_score')"), 'replay source must project rank_score from forecast_data')
    assert(state.sql?.includes('AS model_ic'), 'replay source must project scalar model_ic')
    assert(!state.sql?.includes('      p.forecast_data,\n'), 'replay source must not send raw forecast_data payloads')
    assert(!state.sql?.includes('      dr.score_components,\n'), 'replay source must not send raw score_components payloads')
    assert(!state.sql?.includes('      dr.ml_vote_summary,\n'), 'replay source must not send raw ml_vote_summary payloads')
    assert(!state.sql?.includes('      dr.alpha_context,\n'), 'replay source must not send raw alpha_context payloads')
    assert(!state.sql?.includes('      dr.alpha_allocation\n'), 'replay source must not send raw alpha_allocation payloads')
    assert(state.binds?.includes('TabM'), 'active-8 replay source must include TabM')
    assert(state.binds?.includes('iTransformer'), 'active-8 replay source must include iTransformer')
    assert(!state.binds?.includes('TimesFM'), 'active-8 replay source must keep TimesFM out of direct alpha replay')
    assert(state.binds?.at(-1) === 12, 'D1 replay query limit must be bounded and bound as last parameter')
  }

  {
    const { db } = makeFakeDb([
      {
        date: '2026-06-05',
        stock_id: '2330',
        symbol: '2330',
        model_name: 'LightGBM',
        direction_correct: 1,
        actual_return_pct: 0.03,
      },
    ])
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
        status: 'candidate',
        allowed_use: 'research_only',
        best_ranked_method: 'NeuralUCB',
        recommended_method: null,
        sample_windows: 10,
        allocator_policy_candidate: {
          schema_version: 'allocator-policy-candidate-v1',
          candidate_type: 'family_allocator_model_weight_multipliers',
          status: 'candidate_requires_approval',
          approved: false,
          mutation_allowed: false,
          production_effect: false,
          proposed_production_effect: 'capped_production_effect',
          allowed_target: 'ml:adaptive_params.model_allocator',
          model_multiplier_cap: 0.15,
          model_weight_multipliers: {
            LightGBM: 1.15,
            XGBoost: 1.15,
            ExtraTrees: 1.15,
            TabM: 0.85,
          },
        },
        gates: [{ name: 'min_windows', passed: true }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const result = await runAdaptiveMetaPolicyReplay({
        DB: db,
        KV: kv,
        ML_SERVICE_URL: 'https://ml.example.com/',
        ML_SERVICE_SECRET: 'service-secret',
      }, {
        startDate: '2026-05-01',
        endDate: '2026-06-08',
        limit: 5,
        persist: true,
      })

      assert(fetchUrl === 'https://ml.example.com/meta-learning/adaptive-policy-replay', 'runner must call the adaptive replay endpoint')
      assert(fetchHeaders.get('X-Service-Token') === 'service-secret', 'runner must pass service token when configured')
      assert(fetchBody.rows.length === 1, 'runner must send Active-8 direct-alpha verified rows to ML service')
      assert(fetchBody.min_ic_samples === 5, 'runner must send bounded default min_ic_samples')
      assert(result.mode === 'persisted_evidence', 'persisted mode should be explicit')
      assert(result.production_effect === false, 'replay must be marked non-production')
      assert(result.mutation_allowed === false, 'replay must be marked mutation-forbidden')
      assert(result.real_trading_allowed === false, 'replay must be marked real-trading forbidden')
      assert(result.allocator_policy_candidate?.status === 'candidate_requires_approval', 'adaptive replay evidence must preserve allocator policy candidate packet')
      assert(result.summary.includes('allocator_candidate=candidate_requires_approval'), 'summary must expose allocator candidate status for OBS triage')
      assert(writes.some((row) => row.key === 'meta:adaptive_policy_replay:latest'), 'persisted replay must write latest evidence key')
      assert(writes.some((row) => row.key === 'meta:adaptive_policy_replay:2026-06-08'), 'persisted replay must write date evidence key')
      assert(writes.every((row) => row.key.startsWith('meta:adaptive_policy_replay:')), 'adaptive replay must only persist evidence keys')
      assert(writes.some((row) => JSON.parse(row.value).allocator_policy_candidate?.candidate_type === 'family_allocator_model_weight_multipliers'), 'persisted replay evidence must include allocator candidate packet')
      assert(!writes.some((row) => row.key === 'trading:config' || row.key === 'ml:adaptive_params'), 'adaptive replay must not mutate live config keys')
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})()
