import { buildOpsResourceAudit, buildOpsRunbook } from './opsRunbook'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const runbook = buildOpsRunbook()
  assert(runbook.version === 'ops-runbook-v1', 'ops runbook should expose stable contract')
  assert(runbook.mode === 'read_only', 'ops runbook route should be read-only')
  assert(runbook.rollback_playbook.every((step) => step.mutation_requires_approval), 'rollback mutations must require approval')
  assert(runbook.resource_cleanup.some((step) => step.id === 'cloud_run_stale_revisions'), 'Cloud Run cleanup audit should be present')
  assert(runbook.resource_cleanup.some((step) => step.id === 'stale_kv_keys'), 'KV stale-key audit should be present')
  assert(runbook.release_gate.includes('OBS drilldown check'), 'release gate should include OBS drilldown')
  assert(runbook.disaster_drill.some((step) => step.id === 'callback_round_trip'), 'callback round-trip drill should be present')
}

class FakeStatement {
  constructor(private readonly sql: string) {}
  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes('page_count')) return { page_count: 1000 } as T
    if (this.sql.includes('freelist_count')) return { freelist_count: 250 } as T
    return {} as T
  }
}

class FakeKV {
  async list(opts?: { prefix?: string; limit?: number }) {
    const count = opts?.prefix === 'backup:' ? 250 : opts?.prefix === 'scheduler:manual:' ? 20 : 5
    return {
      keys: Array.from({ length: Math.min(count, opts?.limit ?? 1000) }, (_, index) => ({ name: `${opts?.prefix ?? ''}${index}` })),
      list_complete: true,
    }
  }
}

void (async () => {
  const audit = await buildOpsResourceAudit({
    DB: { prepare: (sql: string) => new FakeStatement(sql) } as unknown as D1Database,
    KV: new FakeKV() as unknown as KVNamespace,
  })

  assert(audit.version === 'ops-resource-audit-v1', 'resource audit should expose stable contract')
  assert(audit.mode === 'read_only', 'resource audit must be read-only')
  assert(audit.items.every((item) => item.mutation_allowed === false), 'resource audit must never mutate resources')
  assert(audit.items.some((item) => item.id === 'd1_bloat' && item.status === 'warn'), 'D1 bloat should warn when freelist ratio is high')
  assert(audit.items.some((item) => item.id === 'kv_stale_prefixes' && item.status === 'warn'), 'KV stale prefix growth should warn')
  assert(audit.items.some((item) => item.id === 'cloud_run_revisions' && item.status === 'manual_required'), 'Cloud Run audit should be marked manual from Worker')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
