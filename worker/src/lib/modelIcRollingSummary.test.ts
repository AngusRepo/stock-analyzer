import { summarizeRollingIc } from './controllerDailyWorkflows'
import { classifySchedulerSummary, SCHEDULER_RUN_SUMMARY_MAX_CHARS } from './schedulerRunLogger'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

// 2026-11-26: every champion IC was none since 8/27 and the summary only said `| none`.
// The run completed, so the status stays success (model-ic-rolling is a required daily stage;
// blocked/error would read as overdue / upstream-blocked); the summary carries the signal.
const allNone = summarizeRollingIc({
  n_rows_total: 66_000,
  per_model_ic: {
    LightGBM: { status: 'insufficient_samples', root_cause: 'artifact_identity_mismatch', n_samples: 0 },
    XGBoost: { status: 'insufficient_samples', root_cause: 'artifact_identity_mismatch', n_samples: 0 },
    'LightGBM::challenger': { status: 'insufficient_samples', root_cause: 'prediction_missing', n_samples: 0 },
    DLinear: { status: 'insufficient_samples', n_samples: 0 },
  },
}, '2026-11-25')
const allNoneStatus = classifySchedulerSummary(allNone)
assert(allNoneStatus === 'success', `no computed model keeps the completed run success, got ${allNoneStatus}: ${allNone}`)
assert(allNoneStatus !== 'blocked' && allNoneStatus !== 'error', 'never blocked/error for a completed run')
assert(allNone.includes('computed=0/4 attention=no_model_ic_computed'), `summary flags zero computed models: ${allNone}`)
assert(allNone.includes('root_causes=artifact_identity_mismatch=2,insufficient_samples=1,prediction_missing=1'),
  `summary aggregates root causes (status stands in when root_cause is absent): ${allNone}`)
assert(allNone.includes('LightGBM=artifact_identity_mismatch') && allNone.includes('LightGBM__challenger=prediction_missing'),
  'summary names each uncomputed model with its root cause')
assert(allNone.includes('run_date=2026-11-25 n_rows=66000'), 'summary keeps run_date and row count')
assert(!/status=|blocked/.test(allNone), 'summary carries no status marker')

const partial = summarizeRollingIc({
  n_rows_total: 10,
  per_model_ic: {
    LightGBM: { status: 'computed', root_cause: 'ok', ic: 0.0412, n_samples: 9551 },
    'LightGBM::challenger': { status: 'insufficient_samples', root_cause: 'prediction_missing', n_samples: 0 },
  },
})
assert(classifySchedulerSummary(partial) === 'success', `a computed champion keeps success: ${partial}`)
assert(partial.includes('LightGBM:0.041(9551)') && partial.includes('computed=1/2'), 'computed models stay listed')
assert(!partial.includes('attention='), 'no attention marker once a model is computed')
assert(partial.includes('root_causes=prediction_missing=1') && partial.includes('run_date=latest'), 'partial root causes listed')

// Dual track: with no serving-version IC, previously served versions' diagnostics IC is shown.
const promoted = summarizeRollingIc({
  n_rows_total: 65907,
  per_model_ic: {
    LightGBM: { status: 'insufficient_samples', root_cause: 'artifact_version_mismatch', n_samples: 0, ic_by_version: {
      v20261011204631: { status: 'computed', ic: 0.090463, n_dates: 16, serving_version: false },
      v20261109102955: { status: 'insufficient_samples', ic: null, n_dates: 0, serving_version: true } } },
    iTransformer: { status: 'insufficient_samples', root_cause: 'artifact_version_mismatch', ic_by_version: {
      v20261011204631: { status: 'computed', ic: -0.284516, n_dates: 16, serving_version: false } } },
    DLinear: { status: 'insufficient_samples', root_cause: 'prediction_missing', ic_by_version: {} },
  },
}, '2026-11-25')
assert(classifySchedulerSummary(promoted) === 'success', `prior-version IC keeps success: ${promoted}`)
assert(promoted.includes('| prior_version_ic LightGBM@v20261011204631=0.0905(16d) iTransformer@v20261011204631=-0.2845(16d) |'),
  `prior versions listed, serving version excluded: ${promoted}`)
assert(!promoted.includes('v20261109102955'), 'the uncomputed serving version is not listed as prior IC')
const servingComputed = summarizeRollingIc({ per_model_ic: { LightGBM: { status: 'computed', ic: 0.05, n_samples: 900,
  ic_by_version: { vOld: { status: 'computed', ic: 0.1, n_dates: 12, serving_version: false } } } } })
assert(!servingComputed.includes('prior_version_ic'), 'prior IC appears only when no serving-version IC exists')
assert(summarizeRollingIc({ per_model_ic: { LightGBM: { status: 'computed', n_samples: 1 } } }).includes('LightGBM:na(1)'),
  'a computed entry without a finite ic prints na')

// Controller strings are sanitized: hostile version / model / cause names cannot flip the classifier.
const hostile = ['status=blocked', 'status=error', 'not_sent:x', 'not delivered: x', 'kv=fail', 'kv push failed',
  'promotion_failed', 'failed_validation', 'did not update kv', 'callback expected', 'started (background)', 'x\nstatus=blocked']
const adversarial = summarizeRollingIc({
  n_rows_total: 'status=blocked',
  per_model_ic: Object.fromEntries(hostile.map((name, i) => [name, {
    status: 'insufficient_samples', root_cause: hostile[(i + 1) % hostile.length], n_samples: 'x',
    ic_by_version: Object.fromEntries(hostile.map((version) => [version, { status: 'computed', ic: 0.1, n_dates: 10, serving_version: false }])),
  }])),
}, '2026-11-25')
assert(classifySchedulerSummary(adversarial) === 'success', `hostile names keep success: ${adversarial.slice(0, 400)}`)
assert(!/status=(?!.)|status=b|status=e|kv=fail|not_sent:|not delivered:|promotion_failed|failed_validation|kv push failed|callback expected|\n/.test(adversarial),
  'no classifier marker survives sanitizing')
assert(adversarial.includes('status_blocked@unsafe_token=0.1000(10d)') && adversarial.includes(' unsafe_token=')
  && adversarial.includes('n_rows=na'), `replaced tokens stay visible: ${adversarial.slice(0, 300)}`)
assert(adversarial.includes('status_blocked@not_sent_x=0.1000(10d)'), `characters outside [A-Za-z0-9._@-] become _: ${adversarial.slice(0, 300)}`)

const many = summarizeRollingIc({ per_model_ic: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`M${i}`, {
  status: 'insufficient_samples', root_cause: 'artifact_version_mismatch', ic_by_version: Object.fromEntries(Array.from({ length: 6 },
    (_, j) => [`v2026110${j}000000`, { status: 'computed', ic: 0.01, n_dates: 10, serving_version: false }])) }])) })
assert(many.includes(' +78_more') && many.length < 4000 && classifySchedulerSummary(many) === 'success',
  `prior list is capped below the run-log summary limit (${many.length})`)

// Tokens that are each safe can form a marker once joined by `=`/`:`; the assembled summary falls
// back to our own counts only.
const combined: Record<string, any> = {
  uncomputed_status_blocked: { status: { status: 'insufficient_samples', root_cause: 'blocked' } },
  uncomputed_status_error: { status: { status: 'insufficient_samples', root_cause: 'error' } },
  uncomputed_kv_fail: { kv: { status: 'insufficient_samples', root_cause: 'fail' } },
  computed_not_sent: { not_sent: { status: 'computed', ic: 0.1, n_samples: 5 } },
}
for (const [label, perModel] of Object.entries(combined)) {
  const summary = summarizeRollingIc({ n_rows_total: 1, per_model_ic: perModel }, '2026-11-25')
  const computedCount = label.startsWith('computed') ? 1 : 0
  assert(classifySchedulerSummary(summary) === 'success', `${label} keeps success: ${summary}`)
  assert(summary === `rolling_ic owner=D1Registry run_date=2026-11-25 n_rows=1 computed=${computedCount}/1`
    + (computedCount ? '' : ' attention=no_model_ic_computed') + ' summary_tokens_redacted', `${label} carries counts only: ${summary}`)
}
const priorStatus = summarizeRollingIc({ per_model_ic: { status: { status: 'insufficient_samples', root_cause: 'x',
  ic_by_version: { blocked: { status: 'computed', ic: 0.1, n_dates: 3, serving_version: false } } } } })
assert(classifySchedulerSummary(priorStatus) === 'success' && priorStatus.includes('status@blocked=0.1000(3d)'),
  `an \`@\` join forms no marker and stays listed: ${priorStatus}`)
assert(summarizeRollingIc({ per_model_ic: {} }, 'status=blocked').includes('run_date=latest'), 'run_date accepts only YYYY-MM-DD')

const longAndMany = summarizeRollingIc({ n_rows_total: 1, per_model_ic: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [
  'M'.repeat(200) + i, { status: 'insufficient_samples', root_cause: 'r'.repeat(300) + i,
    ic_by_version: Object.fromEntries(Array.from({ length: 6 }, (_, j) => ['v'.repeat(150) + j,
      { status: 'computed', ic: -1e-9, n_dates: 1e20, serving_version: false }])) }])) }, '2026-11-25')
assert(longAndMany.length <= SCHEDULER_RUN_SUMMARY_MAX_CHARS && classifySchedulerSummary(longAndMany) === 'success',
  `extreme names stay within the run-log summary limit (${longAndMany.length}): ${longAndMany.slice(0, 200)}`)
const manyCauses = summarizeRollingIc({ per_model_ic: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`M${i}`,
  { status: 'insufficient_samples', root_cause: `cause_${String(i).padStart(2, '0')}` }])) })
assert(manyCauses.includes('cause_11=1,+28_more') && manyCauses.includes('M23=cause_23 +16_more')
  && classifySchedulerSummary(manyCauses) === 'success', `root_causes and uncomputed lists are capped: ${manyCauses}`)

const empty = summarizeRollingIc({ n_rows_total: 0, per_model_ic: {} })
assert(classifySchedulerSummary(empty) === 'success' && empty.includes('computed=0/0 attention=no_model_ic_computed'),
  'an empty IC response is flagged in the summary')
console.log('modelIcRollingSummary tests passed')
