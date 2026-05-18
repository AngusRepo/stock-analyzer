import { runPaperActivePostmarketPromotion } from './controllerWorkflows'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function createMockEnv() {
  const dbCalls: Array<{ sql: string; params: unknown[] }> = []
  const env = {
    ML_CONTROLLER_URL: 'https://controller.example',
    ML_CONTROLLER_SECRET: 'secret',
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                dbCalls.push({ sql, params })
                return { success: true }
              },
            }
          },
        }
      },
    },
  }
  return { env, dbCalls }
}

async function runCheck() {
  const { env, dbCalls } = createMockEnv()
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetchCalls.push({ url: String(url), init })
    return new Response(JSON.stringify({
      schema_version: 'paper-challenger-postmarket-report-v1',
      generated_at: '2026-05-17T13:45:00Z',
      candidate_count: 1,
      evaluated_count: 1,
      promotion_packets: [
        {
          candidate_id: 'finlab-broker-concentration',
          candidate_type: 'finlab_feature',
          current_state: 'paper_active_challenger',
          next_state: 'paper_primary',
          decision: 'PROMOTE_TO_PAPER_PRIMARY',
          failed_gates: [],
          challenger_metrics: {
            paper_decision_count: 42,
            precision_at_k: 0.54,
            hit_rate: 0.58,
            avg_return_pct: 3.2,
            max_drawdown_pct: -6.4,
            turnover_ratio: 2.8,
            topk_overlap: 0.74,
            regime_split_passed: true,
            runtime_speedup_pct: 12.5,
          },
          real_trading_effect: 'none',
        },
      ],
      audit_events: [
        {
          candidate_id: 'finlab-broker-concentration',
          from_state: 'paper_active_challenger',
          to_state: 'paper_primary',
          decision: 'PROMOTE_TO_PAPER_PRIMARY',
          failed_gates: [],
          packet: { real_trading_effect: 'none' },
          real_trading_effect: 'none',
        },
      ],
      real_trading_effect: 'none',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const summary = await runPaperActivePostmarketPromotion(env as any, '2026-05-17')
    assert(fetchCalls.length === 1, 'controller should be called once')
    assert(fetchCalls[0].url === 'https://controller.example/paper_challenger/postmarket_report', 'controller path should be stable')
    assert(String(fetchCalls[0].init?.body).includes('"run_date":"2026-05-17"'), 'run_date should be posted to controller')
    assert(summary.includes('candidate_count=1'), 'summary should include candidate count')
    assert(summary.includes('persisted candidates=1 metrics=1 audits=1'), 'summary should include persistence counts')
    assert(dbCalls.some((call) => call.sql.includes('paper_challenger_candidates')), 'candidate state should persist')
    assert(dbCalls.some((call) => call.sql.includes('paper_challenger_daily_metrics')), 'daily metrics should persist')
    assert(dbCalls.some((call) => call.sql.includes('promotion_audit_events')), 'audit event should persist')
    assert(!dbCalls.some((call) => call.sql.includes('paper_orders')), 'postmarket promotion must not write orders')
  } finally {
    globalThis.fetch = originalFetch
  }
}

void runCheck()
