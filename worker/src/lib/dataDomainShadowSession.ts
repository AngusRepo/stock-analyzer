import type { DataDomain } from './dataDomainRegistry'

export function dataDomainShadowBackfillActiveKey(domain: DataDomain): string {
  return `data-domain-shadow-backfill:${domain}:active`
}

export async function activeDataDomainShadowBackfillRunId(
  kv: KVNamespace,
  domain: DataDomain,
): Promise<string | null> {
  const value = await kv.get(dataDomainShadowBackfillActiveKey(domain))
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    if (parsed && typeof parsed === 'object' && 'run_id' in parsed) {
      const runId = String((parsed as { run_id?: unknown }).run_id ?? '').trim()
      if (runId) return runId
    }
  } catch {}
  return value.trim() || null
}
