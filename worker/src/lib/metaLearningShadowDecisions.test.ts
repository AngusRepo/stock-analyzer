import {
  hydrateMatureMetaShadowDecisionRewards,
  normalizeMetaShadowDecisionInput,
  summarizeMetaShadowDecisionRows,
} from './metaLearningShadowDecisions'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const normalized = normalizeMetaShadowDecisionInput({
    policy_id: 'NeuralUCB',
    decisions: [
      {
        business_date: '2026-05-07',
        symbol: '2330',
        arm_id: 'tree_family',
        baseline_action: 'hold',
        shadow_action: 'buy',
        counterfactual_reward: 0.012,
        context: { regime: 'bull' },
        evidence: { reason: 'higher exploration score' },
      },
    ],
  }, { nowIso: '2026-05-08T00:00:00.000Z', idPrefix: 'test' })

  assert(normalized.ok, `input should be valid: ${normalized.errors.join(',')}`)
  assert(normalized.rows.length === 1, 'should normalize one row')
  assert(normalized.rows[0].decision_id === 'test-NeuralUCB-2026-05-07-2330-tree_family-0', 'decision id should be stable')
  assert(normalized.rows[0].policy_id === 'NeuralUCB', 'policy id should be preserved')
  assert(normalized.rows[0].context_json.includes('"regime":"bull"'), 'context should be serialized')
}

{
  const normalized = normalizeMetaShadowDecisionInput({
    policy_id: 'NeuCB',
    decisions: [
      { business_date: '2026-05-07', symbol: '2330', arm_id: 'tree_family', baseline_action: 'hold', shadow_action: 'buy', counterfactual_reward: 0.014 },
    ],
  }, { nowIso: '2026-05-08T00:00:00.000Z', idPrefix: 'test' })

  assert(normalized.ok, `NeuCB research benchmark should be valid: ${normalized.errors.join(',')}`)
  assert(normalized.rows[0].policy_id === 'NeuCB', 'NeuCB policy id should be preserved')
}

{
  const invalid = normalizeMetaShadowDecisionInput({
    policy_id: 'OnlinePortfolioBandit',
    decisions: [{ business_date: '2026-05-07', symbol: '2330', arm_id: 'x', baseline_action: 'hold', shadow_action: 'buy' }],
  })
  assert(!invalid.ok, 'non-shadow policies should not be accepted by shadow decision ingestion')
  assert(invalid.errors.includes('unsupported_shadow_policy:OnlinePortfolioBandit'), 'should explain unsupported policy')
}

{
  const normalized = normalizeMetaShadowDecisionInput({
    policy_id: 'NeuralTS',
    decisions: [
      { business_date: '2026-05-07', symbol: '2330', arm_id: 'a', baseline_action: 'hold', shadow_action: 'buy', counterfactual_reward: 0.01 },
      { business_date: '2026-05-07', symbol: '4938', arm_id: 'a', baseline_action: 'hold', shadow_action: 'hold', counterfactual_reward: -0.02 },
    ],
  }, { nowIso: '2026-05-08T00:00:00.000Z', idPrefix: 'test' })
  const summary = summarizeMetaShadowDecisionRows(normalized.rows)
  assert(summary.samples === 2, 'summary should count samples')
  assert(summary.counterfactual_reward_mean === -0.005, 'summary should average counterfactual reward')
  assert(summary.changed_action_count === 1, 'summary should count action changes')
}

void (async () => {
  const sourceRows = [
    {
      decision_id: 'tree-1', business_date: '2026-07-22', symbol: '2330', arm_id: 'tree_family',
      evidence_json: '{"source":"shadow"}', model_name: 'XGBoost', direction_correct: 1, actual_return_pct: 2,
    },
    {
      decision_id: 'tree-1', business_date: '2026-07-22', symbol: '2330', arm_id: 'tree_family',
      evidence_json: '{"source":"shadow"}', model_name: 'PatchTST', direction_correct: 0, actual_return_pct: -2,
    },
    {
      decision_id: 'noop-1', business_date: '2026-07-22', symbol: '2454', arm_id: 'do_nothing',
      evidence_json: '{}', model_name: 'GNN', direction_correct: 1, actual_return_pct: 3,
    },
    {
      decision_id: 'unmatched-1', business_date: '2026-07-22', symbol: '2317', arm_id: 'graph_family',
      evidence_json: '{}', model_name: 'DLinear', direction_correct: 1, actual_return_pct: 3,
    },
  ]
  const updates: unknown[][] = []
  const fakeDb = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              assert(sql.includes('d.counterfactual_reward IS NULL'), 'hydration should only read unresolved decisions')
              return { results: sourceRows }
            },
            async run() {
              assert(sql.includes('AND counterfactual_reward IS NULL'), 'hydration update must be compare-and-set')
              updates.push(args)
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  } as unknown as D1Database

  const report = await hydrateMatureMetaShadowDecisionRewards(fakeDb, {
    endDate: '2026-08-04',
    nowIso: '2026-08-04T10:00:00.000Z',
  })
  assert(report.source_rows === 4, 'hydration should report joined mature source rows')
  assert(report.eligible_decisions === 3, 'hydration should group by decision id')
  assert(report.hydrated_decisions === 2, 'matched family and do-nothing decisions should hydrate')
  assert(report.unmatched_decisions === 1, 'unmatched family decisions should remain pending')
  assert(updates.length === 2, 'hydration should persist only evidence-backed rewards')
  const treeUpdate = updates.find((args) => args[2] === 'tree-1')
  const noopUpdate = updates.find((args) => args[2] === 'noop-1')
  assert(Number(treeUpdate?.[0]) > 0, 'tree arm should use only matching tree model outcome')
  assert(noopUpdate?.[0] === 0, 'do-nothing counterfactual should be zero')
  assert(
    String(treeUpdate?.[1]).includes('verified_mature_outcome'),
    'hydrated evidence should declare mature outcome provenance',
  )
})()
