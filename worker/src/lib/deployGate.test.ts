import { buildComputeProfileWaitColumnsCheck, buildFinLabCanonicalD1FreshnessCheck, summarizeGateChecks } from './deployGate'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const status = summarizeGateChecks([
    { id: 'compile', status: 'ok', summary: 'ok' },
    { id: 'data_quality', status: 'warn', summary: 'warn' },
  ])
  assert(status === 'warn', 'deploy gate should surface warning checks')
}

{
  const status = summarizeGateChecks([
    { id: 'compile', status: 'ok', summary: 'ok' },
    { id: 'scheduler', status: 'fail', summary: 'failed24h=1' },
  ])
  assert(status === 'fail', 'deploy gate should block on any failed check')
}

{
  const check = buildFinLabCanonicalD1FreshnessCheck({
    canonical_chip_date: '2026-05-15',
    canonical_chip_rows: 2629,
    legacy_chip_date: '2026-05-21',
    legacy_chip_rows: 15256,
    margin_date: '2026-05-21',
    margin_rows: 1839,
    manifest_generated_at: '2026-05-18T02:53:36Z',
  })

  assert(check.status === 'fail', 'deploy gate should block when FinLab canonical D1 lags fresh daily source tables')
  assert(check.id === 'finlab_canonical_d1_freshness', 'FinLab canonical D1 check should have a stable gate id')
  assert(String(check.metrics?.required_job_arg) === '--apply-canonical-d1', 'FinLab freshness gate should point to the canonical apply job arg')
}

{
  const check = buildFinLabCanonicalD1FreshnessCheck({
    canonical_market_date: '2026-05-21',
    canonical_market_rows: 2718,
    canonical_chip_date: '2026-05-21',
    canonical_chip_rows: 2629,
    institutional_amount_date: '2026-05-19',
    institutional_amount_rows: 14,
    broker_flow_date: '2026-05-21',
    broker_flow_rows: 1600,
  } as any)

  assert(check.status === 'fail', 'deploy gate should block when official institutional amount canonical data lags market/chip data')
  assert(check.summary.includes('canonical_institutional_amount_daily'), 'institutional amount lag should be explicit in gate summary')
}

{
  const check = buildFinLabCanonicalD1FreshnessCheck({
    canonical_market_date: '2026-05-21',
    canonical_market_rows: 2718,
    canonical_chip_date: '2026-05-21',
    canonical_chip_rows: 2629,
    institutional_amount_date: '2026-05-21',
    institutional_amount_rows: 14,
    broker_flow_date: '2026-05-21',
    broker_flow_rows: 1600,
  } as any)

  assert(check.status === 'ok', 'deploy gate should pass when FinLab canonical D1 is aligned with daily source tables')
  assert(Array.isArray(check.metrics?.required_canonical_datasets), 'deploy gate should expose the required FinLab canonical datasets')
}

{
  const check = buildComputeProfileWaitColumnsCheck([
    { name: 'id' },
    { name: 'event_date' },
    { name: 'provider' },
    { name: 'profile_json' },
  ])

  assert(check.status === 'fail', 'deploy gate should block when compute profile wait columns are missing')
  assert(check.id === 'compute_profile_wait_columns', 'compute profile wait-column check should have a stable gate id')
  assert(String(check.metrics?.migration) === 'worker/migration_compute_profile_events_wait_columns.sql', 'gate should point to the additive migration file')
}

{
  const check = buildComputeProfileWaitColumnsCheck([
    { name: 'id' },
    { name: 'await_sec' },
    { name: 'compute_owner' },
    { name: 'remote_function' },
  ])

  assert(check.status === 'ok', 'deploy gate should pass when compute profile wait attribution columns exist')
}
