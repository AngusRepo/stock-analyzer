const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function stripSqlComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

const preflight = fs.readFileSync(
  'preflight_morning_setup_p0_p7_readonly_2026_06_23.sql',
  'utf8',
)
const runbook = fs.readFileSync(
  'runbook_morning_setup_p0_p7_post_deploy_validation_2026_06_23.md',
  'utf8',
)

const preflightWithoutComments = stripSqlComments(preflight)

assert(
  !/\b(ALTER|CREATE|DELETE|DROP|INSERT|MERGE|REPLACE|TRUNCATE|UPDATE)\b/i.test(
    preflightWithoutComments,
  ),
  'P7 read-only preflight SQL must not contain mutation statements',
)

assert(
  !/\b(npx(?:\.cmd)?\s+)?wrangler(?:@\d+)?\b[\s\S]*?--remote\s+--file/i.test(preflight),
  'P7 read-only preflight SQL must not include executable remote D1 --file commands',
)

assert(
  preflight.includes('Do not run this read-only audit with `--remote --file`'),
  'P7 read-only preflight SQL must warn against remote D1 --file execution',
)

for (const auditName of [
  'p7_schema_pending_buy_filter_audit',
  'p7_latest_pending_buy_run',
  'p7_schema_sector_flow_rotation_model',
  'p7_pending_buy_filter_audit_latest_run',
  'p7_rrg_latest_rs_snapshot',
  'p7_rrg_rotation_model_latest_snapshot',
  'p7_formal137_missing_feature_refs_latest_recommendations',
  'p7_timesfm_sidecar_latest_ensemble',
]) {
  assert(
    preflight.includes(auditName),
    `P7 read-only preflight SQL must include ${auditName}`,
  )
}

assert(
  runbook.includes(
    'Do not execute deploy, D1 migration, scheduler rerun, or any production mutation without explicit Wei approval',
  ),
  'P7 runbook must preserve explicit production-mutation approval boundary',
)

for (const requiredText of [
  'migration_pending_buy_filter_audit_2026_06_23.sql',
  'migration_sector_flow_rotation_model_2026_06_23.sql',
  'preflight_morning_setup_p0_p7_readonly_2026_06_23.sql',
  'reject_action_rows = 0',
  'missing_momentum_classified_rows = 0',
  'rotation_score_rows',
  'rotation_regime_rows',
  'transition_path_rows',
  'valid_tail_json_rows',
  'rrg_rotation_model:<regime>:score=<score>:path=<transition_path>',
  'timesfm_direct_weight_rows = 0',
  'timesfm_l2_feature_input_active_rows = 0',
  'timesfm_l2_blocked_reason_rows',
  'L2 block formal137/retrain/release',
  'not delivered: no_channel_configured',
  'sent to not_sent:no_channel_configured',
  'L2 TimesFM sidecar',
  'ML vote denominator should be 8 direct-alpha models',
]) {
  assert(
    runbook.includes(requiredText),
    `P7 runbook must include validation marker: ${requiredText}`,
  )
}

assert(
  runbook.includes('Do not run this read-only audit against remote D1 with `--remote --file`.') &&
    runbook.includes('Use `--command` for each SELECT'),
  'P7 runbook must make read-only D1 validation executable only via --command',
)

console.log('morningSetupP7PostDeployValidationContract: ok')
