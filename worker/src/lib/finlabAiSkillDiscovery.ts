import type { StrategySpec, StrategySpecCandidatePolicy, StrategySpecStatus, StrategySpecThresholds } from './strategySpec'
import { STRATEGY_SPEC_VERSION, validateStrategySpec } from './strategySpec'
import {
  normalizeResearchExperimentInput,
  putResearchExperiment,
  type ResearchExperimentRecord,
  type ResearchExperimentStatus,
} from './researchExperimentRegistry'
import { upsertStrategySpecRegistry } from './strategyLearning'

export const FINLAB_AI_SKILL_DISCOVERY_ID = 'finlab_ai_skill_discovery_v1'
export const FINLAB_AI_SKILL_DISCOVERY_VERSION = 'finlab-ai-skill-discovery-bridge-v1'

export interface FinLabAiSkillDiscoveryInput {
  id?: string
  hypothesis: string
  taxonomyRefs?: string[]
  factorRefs?: string[]
  sourceRefs?: string[]
  tag?: string
  tagType?: string
  alphaBucket?: StrategySpec['alphaBucket']
  supportedRegimes?: StrategySpec['supportedRegimes']
  thresholds?: Partial<StrategySpecThresholds>
  status?: Extract<StrategySpecStatus, 'research' | 'candidate' | 'active'>
  approvedForL1?: boolean
  metrics?: string[]
  followUp?: string[]
  nowIso?: string
}

export interface FinLabAiSkillDiscoveryBridgePacket {
  ok: boolean
  errors: string[]
  version: typeof FINLAB_AI_SKILL_DISCOVERY_VERSION
  generated_at: string
  strategy_spec: StrategySpec
  research_experiment: ResearchExperimentRecord
  bridge: {
    source: typeof FINLAB_AI_SKILL_DISCOVERY_ID
    path_to_screener_layers: string[]
    registry_effect_if_persisted: 'research_only_queue' | 'l2_coarse_ml_queue'
    production_effect: false
    requires_wei_approval_for_l2_coarse_ml: boolean
  }
}

export interface FinLabAiSkillDiscoveryClosureReport {
  status: 'dry_run' | 'persisted' | 'skipped'
  version: typeof FINLAB_AI_SKILL_DISCOVERY_VERSION
  date: string
  source_rows: number
  packets: FinLabAiSkillDiscoveryBridgePacket[]
  persisted: {
    research_experiments: number
    strategy_specs: number
  }
  skipped_invalid: string[]
  reason?: string
}

interface FinLabTaxonomyDiscoveryRow {
  tag: string | null
  tag_type: string | null
  symbol_count: number | null
  avg_weight?: number | null
  latest_as_of_date?: string | null
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function cleanTextArray(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(cleanText).filter(Boolean))].slice(0, 20)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

function safeStrategyId(input: FinLabAiSkillDiscoveryInput): string {
  const requested = slug(cleanText(input.id ?? ''))
  if (requested) return requested.startsWith('finlab_ai_skill_') ? requested : `finlab_ai_skill_${requested}`
  const tag = slug(cleanText(input.tag ?? input.taxonomyRefs?.[0] ?? 'strategy'))
  const bucket = slug(cleanText(input.alphaBucket ?? 'taxonomy'))
  return `finlab_ai_skill_${bucket}_${tag || 'strategy'}`
}

function supportedRegimes(input: FinLabAiSkillDiscoveryInput): StrategySpec['supportedRegimes'] {
  const allowed = new Set(['bull', 'sideways', 'bear', 'volatile'])
  const regimes = cleanTextArray(input.supportedRegimes).filter((item) => allowed.has(item))
  return (regimes.length ? regimes : ['bull', 'sideways', 'volatile']) as StrategySpec['supportedRegimes']
}

function sourceRefs(input: FinLabAiSkillDiscoveryInput): string[] {
  return [
    FINLAB_AI_SKILL_DISCOVERY_ID,
    ...cleanTextArray(input.sourceRefs),
    ...cleanTextArray(input.taxonomyRefs).map((ref) => `finlab_taxonomy:${ref}`),
    ...cleanTextArray(input.factorRefs).map((ref) => `finlab_factor:${ref}`),
  ].filter((value, index, values) => values.indexOf(value) === index)
}

function statusForInput(input: FinLabAiSkillDiscoveryInput, errors: string[]): Extract<StrategySpecStatus, 'research' | 'candidate' | 'active'> {
  const requested = input.status === 'candidate' || input.status === 'active' ? input.status : 'research'
  if (requested !== 'research' && input.approvedForL1 !== true) {
    errors.push('l1_candidate_status_requires_approved_for_l1')
    return 'research'
  }
  return requested
}

function candidatePolicyForStatus(
  status: Extract<StrategySpecStatus, 'research' | 'candidate' | 'active'>,
): StrategySpecCandidatePolicy {
  const base = {
    poolQuota: 8,
    costBudget: 10,
    evidenceRequirements: ['finlab_ai_skill', 'finlab_factor', 'finlab_taxonomy', 'strategy_hypothesis', 'research_reward'],
  }
  if (status === 'research') return { ...base, maxMlShare: 0 }
  return base
}

export function buildFinLabAiSkillStrategySpecDraft(
  input: FinLabAiSkillDiscoveryInput,
): { ok: boolean; errors: string[]; spec: StrategySpec } {
  const errors: string[] = []
  const nowIso = input.nowIso ?? new Date().toISOString()
  const status = statusForInput(input, errors)
  const tag = cleanText(input.tag)
  const taxonomyRefs = cleanTextArray(input.taxonomyRefs)
  const factorRefs = cleanTextArray(input.factorRefs)
  const alphaBucket = input.alphaBucket ?? 'mean_reversion'
  const includeIndustries = tag ? [tag] : undefined

  const spec: StrategySpec = {
    id: safeStrategyId(input),
    version: STRATEGY_SPEC_VERSION,
    name: `FinLab AI Skill ${tag || slug(input.hypothesis).replace(/_/g, ' ') || 'strategy'} discovery`,
    status,
    owner: 'strategy',
    alphaBucket,
    supportedRegimes: supportedRegimes(input),
    thesis: cleanText(input.hypothesis),
    thresholds: {
      minSeedScore: status === 'research' ? 50 : 56,
      minTechScore: status === 'research' ? 10 : 14,
      minPrice: 10,
      ...(includeIndustries ? { includeIndustries } : {}),
      ...(input.thresholds ?? {}),
    },
    candidatePolicy: candidatePolicyForStatus(status),
    riskNotes: [
      status === 'research'
        ? 'Auto-discovered FinLab AI Skill hypothesis stays in research-only queue until reviewed and explicitly promoted.'
        : 'FinLab AI Skill candidate can pass L1 breadth and enter L2 coarse ML only after explicit approval; allocation/trading gates remain separate.',
      `source_refs=${sourceRefs(input).join('|')}`,
      `generated_at=${nowIso}`,
      ...(taxonomyRefs.length ? [`taxonomy_refs=${taxonomyRefs.join('|')}`] : []),
      ...(factorRefs.length ? [`factor_refs=${factorRefs.join('|')}`] : []),
    ],
    createdBy: 'p5_strategy_governance',
  }

  const validation = validateStrategySpec(spec)
  errors.push(...validation.errors)
  if (!cleanText(spec.thesis)) errors.push('hypothesis_missing')
  return { ok: errors.length === 0, errors, spec }
}

export function buildFinLabAiSkillDiscoveryBridgePacket(
  input: FinLabAiSkillDiscoveryInput,
): FinLabAiSkillDiscoveryBridgePacket {
  const nowIso = input.nowIso ?? new Date().toISOString()
  const draft = buildFinLabAiSkillStrategySpecDraft({ ...input, nowIso })
  const status = draft.spec.status
  const researchStatus: ResearchExperimentStatus = status === 'research' ? 'queued' : 'approved_for_patch'
  const normalized = normalizeResearchExperimentInput({
    id: `finlab-ai-skill-${draft.spec.id}`,
    hypothesis: draft.spec.thesis,
    sourceRefs: sourceRefs(input),
    strategySpecIds: [draft.spec.id],
    dataSlice: {
      source: FINLAB_AI_SKILL_DISCOVERY_ID,
      tag: cleanText(input.tag),
      tag_type: cleanText(input.tagType),
      alpha_bucket: draft.spec.alphaBucket,
      strategy_status: status,
      approved_for_l1: input.approvedForL1 === true,
    },
    metrics: input.metrics ?? ['strategy_reward', 'l1_recall', 'ic_4w_avg', 'pbo'],
    followUp: input.followUp ?? [
      'persist research experiment',
      'upsert generated strategy spec as research',
      'promote to candidate only after reviewed evidence',
    ],
    status: researchStatus,
  }, nowIso)
  const errors = [...draft.errors, ...(normalized.errors ?? [])]
  const fallbackRecord = normalized.record ?? normalizeResearchExperimentInput({
    hypothesis: 'FinLab AI Skill generated an invalid strategy hypothesis that requires manual review.',
    sourceRefs: sourceRefs(input),
    strategySpecIds: [draft.spec.id],
    status: 'needs_more_evidence',
  }, nowIso).record!

  return {
    ok: errors.length === 0 && normalized.ok,
    errors,
    version: FINLAB_AI_SKILL_DISCOVERY_VERSION,
    generated_at: nowIso,
    strategy_spec: draft.spec,
    research_experiment: normalized.record ?? fallbackRecord,
    bridge: {
      source: FINLAB_AI_SKILL_DISCOVERY_ID,
      path_to_screener_layers: [
        'finlab_ai_skill_output',
        'research_experiment_registry',
        'strategy_spec_registry',
        'Layer1 strategy breadth gate reads specs via marketScreener.listStrategySpecsForLearning',
        'Layer1 routes approved candidate or active specs toward the Layer2 coarse ML queue',
        'Layer2 coarse ML gate evaluates the shortlisted queue',
      ],
      registry_effect_if_persisted: status === 'research' ? 'research_only_queue' : 'l2_coarse_ml_queue',
      production_effect: false,
      requires_wei_approval_for_l2_coarse_ml: status !== 'research',
    },
  }
}

function numberOrZero(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function loadFinLabTaxonomyDiscoveryRows(
  db: D1Database,
  date: string,
  options: { limit: number; minSymbols: number },
): Promise<FinLabTaxonomyDiscoveryRow[]> {
  const { results } = await db.prepare(`
    SELECT tag,
           tag_type,
           COUNT(DISTINCT symbol) AS symbol_count,
           AVG(COALESCE(weight, 1.0)) AS avg_weight,
           MAX(as_of_date) AS latest_as_of_date
      FROM finlab_taxonomy_tags
     WHERE tag_type IN ('industry_theme', 'subindustry', 'industry')
       AND (as_of_date IS NULL OR as_of_date <= ?)
     GROUP BY tag, tag_type
    HAVING symbol_count >= ?
     ORDER BY symbol_count DESC, avg_weight DESC, tag ASC
     LIMIT ?
  `).bind(date, options.minSymbols, options.limit).all<FinLabTaxonomyDiscoveryRow>()
  return results ?? []
}

function packetFromTaxonomyRow(
  row: FinLabTaxonomyDiscoveryRow,
  date: string,
  nowIso: string,
): FinLabAiSkillDiscoveryBridgePacket | null {
  const tag = cleanText(row.tag)
  const tagType = cleanText(row.tag_type)
  if (!tag || !tagType) return null
  const symbolCount = numberOrZero(row.symbol_count)
  const avgWeight = Number.isFinite(Number(row.avg_weight)) ? Number(row.avg_weight).toFixed(2) : 'n/a'
  return buildFinLabAiSkillDiscoveryBridgePacket({
    id: `${tagType}_${tag}`,
    hypothesis: `FinLab AI Skill discovered ${tagType}:${tag} breadth with ${symbolCount} covered symbols and avg taxonomy weight ${avgWeight}; evaluate it as a reusable L1 strategy hypothesis before any production promotion.`,
    taxonomyRefs: [`${tagType}:${tag}`],
    factorRefs: ['finlab_taxonomy_breadth', 'score_v2_seed', 'strategy_reward'],
    sourceRefs: [`run_date:${date}`, row.latest_as_of_date ? `latest_as_of_date:${row.latest_as_of_date}` : 'latest_as_of_date:unknown'],
    tag,
    tagType,
    alphaBucket: tagType === 'industry' ? 'defensive_accumulation' : 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    status: 'research',
    nowIso,
  })
}

export async function runFinLabAiSkillDiscoveryClosure(
  env: { DB: D1Database; KV: KVNamespace },
  date: string,
  options: {
    dryRun?: boolean
    limit?: number
    minSymbols?: number
    nowIso?: string
  } = {},
): Promise<FinLabAiSkillDiscoveryClosureReport> {
  const dryRun = options.dryRun === true
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 3), 10))
  const minSymbols = Math.max(3, Math.min(Math.round(options.minSymbols ?? 8), 80))
  const nowIso = options.nowIso ?? new Date().toISOString()

  let rows: FinLabTaxonomyDiscoveryRow[] = []
  try {
    rows = await loadFinLabTaxonomyDiscoveryRows(env.DB, date, { limit, minSymbols })
  } catch (error) {
    return {
      status: 'skipped',
      version: FINLAB_AI_SKILL_DISCOVERY_VERSION,
      date,
      source_rows: 0,
      packets: [],
      persisted: { research_experiments: 0, strategy_specs: 0 },
      skipped_invalid: [],
      reason: `finlab_taxonomy_unavailable:${String(error).slice(0, 160)}`,
    }
  }

  const packets = rows
    .map((row) => packetFromTaxonomyRow(row, date, nowIso))
    .filter((packet): packet is FinLabAiSkillDiscoveryBridgePacket => packet != null)
  const validPackets = packets.filter((packet) => packet.ok)
  const skippedInvalid = packets
    .filter((packet) => !packet.ok)
    .map((packet) => `${packet.strategy_spec.id}:${packet.errors.join('|')}`)

  const report: FinLabAiSkillDiscoveryClosureReport = {
    status: dryRun ? 'dry_run' : validPackets.length ? 'persisted' : 'skipped',
    version: FINLAB_AI_SKILL_DISCOVERY_VERSION,
    date,
    source_rows: rows.length,
    packets,
    persisted: { research_experiments: 0, strategy_specs: 0 },
    skipped_invalid: skippedInvalid,
    reason: validPackets.length ? undefined : 'no_valid_finlab_ai_skill_discoveries',
  }

  if (dryRun || !validPackets.length) return report

  for (const packet of validPackets) {
    await putResearchExperiment(env.KV, packet.research_experiment)
    report.persisted.research_experiments += 1
    const upsert = await upsertStrategySpecRegistry(env.DB, packet.strategy_spec, {
      sourceRefs: packet.research_experiment.source_refs,
      createdBy: FINLAB_AI_SKILL_DISCOVERY_ID,
      nowIso,
    })
    report.persisted.strategy_specs += upsert.upserted
    report.skipped_invalid.push(...upsert.skipped_invalid)
  }
  return report
}
