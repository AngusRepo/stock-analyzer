import {
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
