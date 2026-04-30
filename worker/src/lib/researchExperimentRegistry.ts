import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export const RESEARCH_EXPERIMENT_PREFIX = 'research:experiments:'
export const RESEARCH_REGISTRY_VERSION = 'research-registry-v1'

export type ResearchExperimentStatus = 'draft' | 'queued' | 'running' | 'review_ready' | 'approved_for_patch' | 'rejected' | 'archived'

export interface ResearchExperimentInput {
  id?: string
  hypothesis: unknown
  sourceRefs?: unknown
  strategySpecIds?: unknown
  dataSlice?: unknown
  metrics?: unknown
  followUp?: unknown
  status?: unknown
}

export interface ResearchExperimentRecord {
  id: string
  version: string
  status: ResearchExperimentStatus
  hypothesis: string
  source_refs: string[]
  strategy_spec_ids: string[]
  data_slice: Record<string, unknown>
  metrics: string[]
  follow_up: string[]
  approval_gate: {
    can_research: true
    can_generate_patch_or_report: true
    can_retrain_prod: false
    can_promote: false
    can_deploy: false
    can_trade: false
  }
  created_at: string
  updated_at: string
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function cleanTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(cleanText).filter(Boolean).slice(0, 20)
}

function cleanObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => /^[a-zA-Z0-9_.:-]{1,64}$/.test(key))
      .slice(0, 50),
  )
}

function safeId(value: unknown): string | null {
  const text = cleanText(value).toLowerCase()
  if (!text) return null
  const normalized = text.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return normalized || null
}

function nextId(nowIso: string, hypothesis: string): string {
  const stamp = nowIso.slice(0, 10).replace(/-/g, '')
  const slug = hypothesis.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `${stamp}-${slug || crypto.randomUUID().slice(0, 8)}`
}

export function normalizeResearchExperimentInput(
  input: ResearchExperimentInput,
  nowIso = new Date().toISOString(),
): { ok: boolean; errors: string[]; record: ResearchExperimentRecord | null } {
  assertOwnerCanOwn('research', 'research_hypothesis')
  assertOwnerCanOwn('research', 'experiment_registry')

  const errors: string[] = []
  const hypothesis = cleanText(input.hypothesis)
  if (hypothesis.length < 12) errors.push('hypothesis_too_short')

  const requestedStatus = cleanText(input.status) as ResearchExperimentStatus
  const allowedStatus: ResearchExperimentStatus[] = ['draft', 'queued', 'running', 'review_ready', 'approved_for_patch', 'rejected', 'archived']
  const status = allowedStatus.includes(requestedStatus) ? requestedStatus : 'draft'

  const record: ResearchExperimentRecord | null = hypothesis
    ? {
        id: safeId(input.id) ?? nextId(nowIso, hypothesis),
        version: RESEARCH_REGISTRY_VERSION,
        status,
        hypothesis,
        source_refs: cleanTextArray(input.sourceRefs),
        strategy_spec_ids: cleanTextArray(input.strategySpecIds),
        data_slice: cleanObject(input.dataSlice),
        metrics: cleanTextArray(input.metrics),
        follow_up: cleanTextArray(input.followUp),
        approval_gate: {
          can_research: true,
          can_generate_patch_or_report: true,
          can_retrain_prod: false,
          can_promote: false,
          can_deploy: false,
          can_trade: false,
        },
        created_at: nowIso,
        updated_at: nowIso,
      }
    : null

  return { ok: errors.length === 0 && record != null, errors, record }
}

export function buildResearchReviewPacket(record: ResearchExperimentRecord): string {
  assertOwnerCanOwn('research', 'review_packet')
  return [
    `# ${record.id}`,
    `Status: ${record.status}`,
    `Hypothesis: ${record.hypothesis}`,
    `Strategy specs: ${record.strategy_spec_ids.join(', ') || 'none'}`,
    `Metrics: ${record.metrics.join(', ') || 'none'}`,
    `Follow-up: ${record.follow_up.join('; ') || 'none'}`,
    'Approval gate: research/report only; no production retrain, promote, deploy, or trade.',
  ].join('\n')
}

export async function putResearchExperiment(kv: KVNamespace, record: ResearchExperimentRecord): Promise<void> {
  await kv.put(`${RESEARCH_EXPERIMENT_PREFIX}${record.id}`, JSON.stringify(record))
}

export async function listResearchExperiments(kv: KVNamespace, limit = 50): Promise<ResearchExperimentRecord[]> {
  const listed = await kv.list({ prefix: RESEARCH_EXPERIMENT_PREFIX, limit: Math.max(1, Math.min(limit, 100)) })
  const records: ResearchExperimentRecord[] = []
  for (const key of listed.keys) {
    const record = await kv.get(key.name, 'json') as ResearchExperimentRecord | null
    if (record?.version === RESEARCH_REGISTRY_VERSION) records.push(record)
  }
  return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}
