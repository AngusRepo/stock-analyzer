export interface OpsRunbookStep {
  id: string
  title: string
  owner: string
  command_hint: string
  mutation_requires_approval: boolean
}

export interface OpsRunbookReport {
  success: true
  version: 'ops-runbook-v1'
  mode: 'read_only'
  rollback_playbook: OpsRunbookStep[]
  resource_cleanup: OpsRunbookStep[]
  disaster_drill: OpsRunbookStep[]
  release_gate: string[]
}

export interface OpsResourceAuditItem {
  id: string
  owner: string
  status: 'ok' | 'warn' | 'manual_required'
  summary: string
  metrics: Record<string, unknown>
  mutation_allowed: false
  next_action: string
}

export interface OpsResourceAuditReport {
  success: true
  version: 'ops-resource-audit-v1'
  mode: 'read_only'
  generated_at: string
  items: OpsResourceAuditItem[]
}

export interface OpsResourceAuditEnv {
  DB: D1Database
  KV: KVNamespace
}

async function countKvPrefix(kv: KVNamespace, prefix: string, limit = 1000): Promise<number> {
  const listed = await kv.list({ prefix, limit: Math.max(1, Math.min(limit, 1000)) })
  return listed.keys.length
}

async function firstNumber(db: D1Database, sql: string, key: string): Promise<number | null> {
  const row = await db.prepare(sql).first<Record<string, unknown>>().catch(() => null)
  const value = Number(row?.[key])
  return Number.isFinite(value) ? value : null
}

export async function buildOpsResourceAudit(env: OpsResourceAuditEnv): Promise<OpsResourceAuditReport> {
  const [pageCount, freelistCount, schedulerManualKeys, oldBackupKeys, intradayWarnKeys] = await Promise.all([
    firstNumber(env.DB, 'PRAGMA page_count', 'page_count'),
    firstNumber(env.DB, 'PRAGMA freelist_count', 'freelist_count'),
    countKvPrefix(env.KV, 'scheduler:manual:').catch(() => -1),
    countKvPrefix(env.KV, 'backup:').catch(() => -1),
    countKvPrefix(env.KV, 'intraday:warn:').catch(() => -1),
  ])

  const freeRatio = pageCount && freelistCount != null ? freelistCount / pageCount : null
  return {
    success: true,
    version: 'ops-resource-audit-v1',
    mode: 'read_only',
    generated_at: new Date().toISOString(),
    items: [
      {
        id: 'd1_bloat',
        owner: 'Cloudflare D1',
        status: freeRatio != null && freeRatio > 0.20 ? 'warn' : 'ok',
        summary: freeRatio == null
          ? 'D1 page/freelist metrics unavailable from PRAGMA.'
          : `D1 freelist ratio ${(freeRatio * 100).toFixed(1)}%.`,
        metrics: { page_count: pageCount, freelist_count: freelistCount, freelist_ratio: freeRatio },
        mutation_allowed: false,
        next_action: freeRatio != null && freeRatio > 0.20
          ? 'Schedule approved VACUUM/retention cleanup window; do not mutate from OBS.'
          : 'No D1 cleanup action required from this audit.',
      },
      {
        id: 'kv_stale_prefixes',
        owner: 'Cloudflare KV',
        status: oldBackupKeys > 200 || schedulerManualKeys > 500 || intradayWarnKeys > 500 ? 'warn' : 'ok',
        summary: `KV prefix sample counts: backup=${oldBackupKeys}, scheduler_manual=${schedulerManualKeys}, intraday_warn=${intradayWarnKeys}.`,
        metrics: {
          backup_keys_sampled: oldBackupKeys,
          scheduler_manual_keys_sampled: schedulerManualKeys,
          intraday_warn_keys_sampled: intradayWarnKeys,
          sample_limit_per_prefix: 1000,
        },
        mutation_allowed: false,
        next_action: 'If counts keep growing, approve a retention cleanup script for specific prefixes only.',
      },
      {
        id: 'cloud_run_revisions',
        owner: 'Cloud Run',
        status: 'manual_required',
        summary: 'Worker cannot enumerate Cloud Run revisions directly; use ops runbook command from trusted shell.',
        metrics: { command_hint: 'gcloud run revisions list --service=ml-controller --region=asia-east1' },
        mutation_allowed: false,
        next_action: 'Run read-only revision audit before deleting stale revisions.',
      },
      {
        id: 'artifact_registry_images',
        owner: 'Artifact Registry',
        status: 'manual_required',
        summary: 'Worker cannot enumerate Artifact Registry images directly; use ops runbook command from trusted shell.',
        metrics: { command_hint: 'gcloud artifacts docker images list asia-east1-docker.pkg.dev/<project>/cloud-run-source-deploy/ml-controller' },
        mutation_allowed: false,
        next_action: 'Run read-only image audit before approving retention cleanup.',
      },
    ],
  }
}

export function buildOpsRunbook(): OpsRunbookReport {
  return {
    success: true,
    version: 'ops-runbook-v1',
    mode: 'read_only',
    rollback_playbook: [
      {
        id: 'cloud_run_revision_rollback',
        title: 'Rollback ml-controller to previous healthy Cloud Run revision',
        owner: 'Cloud Run',
        command_hint: 'gcloud run services update-traffic ml-controller --to-revisions <revision>=100 --region=asia-east1',
        mutation_requires_approval: true,
      },
      {
        id: 'worker_version_rollback',
        title: 'Rollback Worker to previous version after smoke failure',
        owner: 'Cloudflare Worker',
        command_hint: 'wrangler deployments rollback <deployment-id>',
        mutation_requires_approval: true,
      },
      {
        id: 'pages_alias_rollback',
        title: 'Rollback frontend Pages alias to previous production deployment',
        owner: 'Cloudflare Pages',
        command_hint: 'Cloudflare Pages deployment rollback from dashboard/API',
        mutation_requires_approval: true,
      },
    ],
    resource_cleanup: [
      {
        id: 'cloud_run_stale_revisions',
        title: 'List stale Cloud Run revisions before deleting',
        owner: 'Cloud Run',
        command_hint: 'gcloud run revisions list --service=ml-controller --region=asia-east1',
        mutation_requires_approval: false,
      },
      {
        id: 'artifact_registry_old_images',
        title: 'Audit Artifact Registry image growth before pruning',
        owner: 'Artifact Registry',
        command_hint: 'gcloud artifacts docker images list asia-east1-docker.pkg.dev/<project>/cloud-run-source-deploy/ml-controller',
        mutation_requires_approval: false,
      },
      {
        id: 'stale_kv_keys',
        title: 'Audit stale KV prefixes before deleting',
        owner: 'Cloudflare KV',
        command_hint: 'wrangler kv key list --namespace-id <id> --prefix <prefix>',
        mutation_requires_approval: false,
      },
      {
        id: 'd1_snapshot_retention',
        title: 'Audit D1 backup/snapshot retention and table bloat',
        owner: 'Cloudflare D1',
        command_hint: 'wrangler d1 execute stockvision-db --remote --command "PRAGMA page_count;"',
        mutation_requires_approval: false,
      },
    ],
    disaster_drill: [
      {
        id: 'callback_round_trip',
        title: 'Verify scheduler callback round-trip after deploy',
        owner: 'GCP Scheduler + Worker',
        command_hint: 'trigger smoke task, then read scheduler callback log',
        mutation_requires_approval: false,
      },
      {
        id: 'paper_live_parity',
        title: 'Verify paper/live execution adapter parity before live trading',
        owner: 'Execution',
        command_hint: 'run paper/live parity contract tests',
        mutation_requires_approval: false,
      },
      {
        id: 'finlab_canonical_d1_repair',
        title: 'Plan and verify FinLab canonical D1 repair after deploy gate blocks stale canonical rows',
        owner: 'FinLab canonical D1',
        command_hint: 'powershell -File scripts/finlab_canonical_d1_repair_plan.ps1 -VerifyD1',
        mutation_requires_approval: false,
      },
    ],
    release_gate: [
      'type-check',
      'contract tests',
      'frontend build',
      'Worker health',
      'ml-controller health',
      'deploy gate',
      'FinLab canonical D1 freshness',
      'OBS drilldown check',
      'callback round-trip',
    ],
  }
}
