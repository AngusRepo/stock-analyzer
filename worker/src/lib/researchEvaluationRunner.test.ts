import type { Bindings } from '../types'
import { buildResearchEvaluationPlan } from './researchEvaluationPlan'
import { listResearchEvaluationRunReports, putResearchEvaluationRunReport, runResearchEvaluationPlan } from './researchEvaluationRunner'
import type { ResearchExperimentRecord } from './researchExperimentRegistry'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const experiment: ResearchExperimentRecord = {
  id: 'exp-runner',
  version: 'research-registry-v1',
  status: 'draft',
  hypothesis: '測試研究計畫只能觸發 dry-run controller endpoint',
  source_refs: ['strategy-lab-test'],
  strategy_spec_ids: ['breakout_vol_expansion_seed_v1'],
  data_slice: { start_date: '2025-01-01', end_date: '2026-04-30' },
  metrics: ['walk_forward_sharpe', 'pbo'],
  follow_up: ['run dry-run evaluation'],
  approval_gate: {
    can_research: true,
    can_generate_patch_or_report: true,
    can_retrain_prod: false,
    can_promote: false,
    can_deploy: false,
    can_trade: false,
  },
  created_at: '2026-04-30T01:00:00.000Z',
  updated_at: '2026-04-30T01:00:00.000Z',
}

class FakeKV {
  store = new Map<string, string>()
  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }
  async put(key: string, value: string) {
    this.store.set(key, value)
  }
  async list(opts?: { prefix?: string; limit?: number }) {
    const keys = [...this.store.keys()]
      .filter((name) => !opts?.prefix || name.startsWith(opts.prefix))
      .sort()
      .slice(0, opts?.limit ?? 100)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  }
}

void (async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    calls.push({ url, body })
    if (url.includes('/backtest/run') || url.includes('/walk_forward/run') || url.includes('/verify/run')) {
      throw new Error(`unsafe endpoint called: ${url}`)
    }
    return new Response(JSON.stringify({ ok: true, endpoint: new URL(url).pathname }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const env = {
      ML_CONTROLLER_URL: 'https://controller.example.test',
      ML_CONTROLLER_SECRET: 'controller-secret',
    } as unknown as Bindings
    const plan = buildResearchEvaluationPlan(experiment)
    const result = await runResearchEvaluationPlan(env, plan)

    assert(result.mode === 'dry_run_execution', 'runner should be explicitly dry-run execution')
    assert(result.verdict === 'ready_for_review', 'successful dry-run report should be ready for review')
    assert(result.review_packet.includes('exp-runner'), 'dry-run report should include a review packet')
    assert(result.results.length === 3, 'runner should execute all safe dry-run steps')
    assert(result.results.every((entry) => entry.status === 'ok'), 'all dry-run calls should succeed')
    assert(calls.length === 3, 'runner should call controller once per safe dry-run step')
    assert(calls.every((call) => call.url.includes('/dry-run') || call.url.includes('/backtest/replay')), 'runner must only call dry-run/replay endpoints')
    assert(calls.every((call) => call.body.mutation_allowed !== true), 'runner must not send mutation_allowed=true')
    assert(calls.every((call) => call.body.experiment_id === 'exp-runner'), 'runner should pass experiment id to controller')

    const kv = new FakeKV() as unknown as KVNamespace
    await putResearchEvaluationRunReport(kv, result)
    const history = await listResearchEvaluationRunReports(kv, 'exp-runner')
    assert(history.length === 1, 'runner should persist one evaluation run report')
    assert(history[0].experiment_id === 'exp-runner', 'persisted report should keep experiment id')
    assert(history[0].verdict === 'ready_for_review', 'persisted report should keep verdict')
    assert(history[0].review_packet.includes('ready_for_review'), 'persisted report should keep review packet')
    assert(history[0].results.length === 3, 'persisted report should keep step results')
    assert(history[0].created_at.includes('T'), 'persisted report should include timestamp')
  } finally {
    globalThis.fetch = originalFetch
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
