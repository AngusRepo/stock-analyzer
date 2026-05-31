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
export const FINLAB_AI_SKILL_DISCOVERY_VERSION = 'finlab-ai-official-skill-discovery-v2'
export const FINLAB_OFFICIAL_STRATEGY_UID = 'TJN4FDuqrwU8DML7DAjUYFIMutp2'
export const FINLAB_OFFICIAL_STRATEGY_CATALOG_URL =
  `https://firestore.googleapis.com/v1/projects/fdata-299302/databases/(default)/documents/users/${FINLAB_OFFICIAL_STRATEGY_UID}`
export const FINLAB_OFFICIAL_STRATEGY_PAGE_URL = 'https://ai.finlab.tw/strategies?tab=FinLab%E5%8F%B0%E8%82%A1'
export const FINLAB_OFFICIAL_DIRECT_ACTIVE_SHARPE_MIN = 1
export const FINLAB_OFFICIAL_DIRECT_ACTIVE_MAX_DRAWDOWN_FLOOR = -0.4
export const FINLAB_RAW_FACTOR_MINER_ID = 'finlab_api_raw_factor_miner_v1'

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
  bindTagToIndustry?: boolean
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
    production_effect: boolean
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

export interface FinLabOfficialStrategySummary {
  sid: string
  name: string
  tags: string[]
  market: 'TW' | 'US' | 'unknown'
  annual_return: number | null
  sharpe_ratio: number | null
  max_drawdown: number | null
  ndays_return: Record<string, number> | null
  public_code: number | null
  public_position: number | null
  public_performance: number | null
  last_updated?: string | null
}

export interface FinLabRawFactorMinerCandidate {
  candidate_id?: string
  lane?: string
  query?: string
  dataset_key?: string
  display_name?: string
  hypothesis?: string
  alpha_bucket?: string
  evidence_requirements?: unknown
  promotion_status?: string
  source_refs?: unknown
  production_effect?: boolean
  strategy_spec_hint?: Record<string, unknown>
}

export interface FinLabRawFactorMinerPayload {
  version?: string
  generated_at?: string
  checksum?: string
  registry_target?: string
  production_effect?: boolean
  summary?: Record<string, unknown>
  candidates?: FinLabRawFactorMinerCandidate[]
  errors?: string[]
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

function shouldBindTagToIndustry(input: FinLabAiSkillDiscoveryInput): boolean {
  if (input.bindTagToIndustry === false) return false
  const tagType = cleanText(input.tagType)
  if (!tagType) return true
  return ['industry_theme', 'subindustry', 'industry'].includes(tagType)
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
    evidenceRequirements: [
      'finlab_ai_skill',
      'finlab_factor',
      'raw_factor_mining',
      'raw_technical_indicator_mining',
      'finlab_taxonomy',
      'strategy_hypothesis',
      'research_reward',
    ],
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
  const includeIndustries = tag && shouldBindTagToIndustry(input) ? [tag] : undefined

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
      production_effect: status === 'active' && input.approvedForL1 === true,
      requires_wei_approval_for_l2_coarse_ml: status !== 'research' && input.approvedForL1 !== true,
    },
  }
}

function numberOrZero(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function decodeFirestoreValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ('stringValue' in record) return String(record.stringValue ?? '')
  if ('integerValue' in record) {
    const parsed = Number(record.integerValue)
    return Number.isFinite(parsed) ? parsed : null
  }
  if ('doubleValue' in record) {
    const parsed = Number(record.doubleValue)
    return Number.isFinite(parsed) ? parsed : null
  }
  if ('booleanValue' in record) return record.booleanValue === true
  if ('timestampValue' in record) return String(record.timestampValue ?? '')
  if ('nullValue' in record) return null
  if ('arrayValue' in record) {
    const values = ((record.arrayValue as Record<string, unknown>)?.values ?? []) as unknown[]
    return values.map(decodeFirestoreValue)
  }
  if ('mapValue' in record) {
    const fields = ((record.mapValue as Record<string, unknown>)?.fields ?? {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(fields)) out[key] = decodeFirestoreValue(child)
    return out
  }
  return value
}

function decodeFirestoreDocument(payload: unknown): Record<string, unknown> {
  const fields = (payload as Record<string, unknown> | null)?.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    out[key] = decodeFirestoreValue(value)
  }
  return out
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function tagTextsForOfficialStrategy(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags
    .map((tag) => cleanText((tag as Record<string, unknown> | null)?.text ?? tag))
    .filter(Boolean))]
}

export function parseFinLabOfficialStrategyCatalog(payload: unknown): FinLabOfficialStrategySummary[] {
  const data = decodeFirestoreDocument(payload)
  const strategies = data.strategies && typeof data.strategies === 'object' && !Array.isArray(data.strategies)
    ? data.strategies as Record<string, Record<string, unknown>>
    : {}
  const tagsBySid = data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags)
    ? data.tags as Record<string, unknown>
    : {}

  return Object.entries(strategies).map(([sid, strategy]) => {
    const tags = tagTextsForOfficialStrategy(tagsBySid[sid])
    const market = tags.includes('美股') ? 'US' : tags.includes('台股') ? 'TW' : 'unknown'
    const ndaysRaw = strategy.ndays_return && typeof strategy.ndays_return === 'object'
      ? strategy.ndays_return as Record<string, unknown>
      : null
    const ndays_return = ndaysRaw
      ? Object.fromEntries(Object.entries(ndaysRaw)
        .map(([key, value]) => [key, numberOrNull(value)])
        .filter((entry): entry is [string, number] => entry[1] != null))
      : null
    return {
      sid,
      name: cleanText(strategy.name) || sid,
      tags,
      market,
      annual_return: numberOrNull(strategy.annual_return),
      sharpe_ratio: numberOrNull(strategy.sharpe_ratio),
      max_drawdown: numberOrNull(strategy.max_drawdown),
      ndays_return,
      public_code: numberOrNull(strategy.public_code),
      public_position: numberOrNull(strategy.public_position),
      public_performance: numberOrNull(strategy.public_performance),
      last_updated: cleanText(strategy.last_updated) || null,
    }
  })
}

export async function fetchFinLabOfficialStrategyCatalog(options: {
  fetcher?: typeof fetch
  url?: string
} = {}): Promise<FinLabOfficialStrategySummary[]> {
  const fetcher = options.fetcher ?? fetch
  const url = options.url ?? FINLAB_OFFICIAL_STRATEGY_CATALOG_URL
  const response = await fetcher(url)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`finlab_official_strategy_catalog_http_${response.status}:${body.slice(0, 120)}`)
  }
  return parseFinLabOfficialStrategyCatalog(await response.json())
}

function officialStrategyFactorRefs(strategy: FinLabOfficialStrategySummary): string[] {
  const refs = new Set<string>(['finlab_official_strategy_catalog', 'raw_factor_mining'])
  const text = `${strategy.sid} ${strategy.name} ${strategy.tags.join(' ')}`
  if (/技術|RSI|突破|趨勢|創高|低價/.test(text)) {
    refs.add('raw_technical_indicator_mining')
    refs.add('technical:rsi14')
    refs.add('technical:volumeExpansion20')
    refs.add('technical:ma_reclaim')
  }
  if (/籌碼|信用|小蝦米|鯨魚|券商|外資|投信|殖利率/.test(text)) {
    refs.add('raw_chip_flow')
    refs.add('raw_broker_flow')
    refs.add('chip:foreignTrustNet5d')
  }
  if (/基本|財報|本益|淨值|價投|研發|現金流|殖利|合約負債|品質/.test(text)) {
    refs.add('raw_profitability')
    refs.add('raw_valuation')
    refs.add('fundamental:roe_eps_pe_pb')
  }
  if (/營收|月營收|成長/.test(text)) {
    refs.add('raw_revenue_revision')
    refs.add('fundamental:monthlyRevenueYoY')
    refs.add('fundamental:monthlyRevenueMoM')
  }
  if (/低波動|膽小/.test(text)) refs.add('risk:low_volatility')
  if (/產業/.test(text)) refs.add('finlab_taxonomy')
  if (/大盤|景氣|總體/.test(text)) refs.add('market_regime')
  if (/事件|恢復信用/.test(text)) refs.add('event_research')
  return [...refs]
}

function officialStrategyThresholds(strategy: FinLabOfficialStrategySummary): Partial<StrategySpecThresholds> {
  const text = `${strategy.sid} ${strategy.name} ${strategy.tags.join(' ')}`
  const thresholds: Partial<StrategySpecThresholds> = { minPrice: 10 }
  if (/技術|RSI|突破|趨勢|創高|低價/.test(text)) {
    thresholds.minVolumeExpansion20 = 0.85
    thresholds.minTechnicalIndicators = { ...(thresholds.minTechnicalIndicators ?? {}), rsi14: 40 }
  }
  if (/營收|月營收|成長/.test(text)) {
    thresholds.minMonthlyRevenueYoY = 0
    thresholds.minFactorSignals = { ...(thresholds.minFactorSignals ?? {}), monthlyRevenueYoY: 0 }
  }
  if (/基本|財報|本益|淨值|價投|研發|現金流|殖利|合約負債|品質/.test(text)) {
    thresholds.minEps = 0
    thresholds.minRoe = 3
    thresholds.maxPe = 60
  }
  if (/籌碼|信用|小蝦米|鯨魚|券商|外資|投信/.test(text)) {
    thresholds.minForeignTrustNet5d = 0
  }
  if (/低波動|膽小/.test(text)) {
    thresholds.maxReturn20d = 0.18
  }
  return thresholds
}

function officialStrategyAlphaBucket(strategy: FinLabOfficialStrategySummary): StrategySpec['alphaBucket'] {
  const text = `${strategy.sid} ${strategy.name} ${strategy.tags.join(' ')}`
  if (/突破|創高|趨勢|RSI|營收|動能/.test(text)) return 'trend_following'
  if (/籌碼|信用|殖利|低波動|膽小/.test(text)) return 'defensive_accumulation'
  if (/價投|本益|淨值|現金流|財報|研發|合約負債/.test(text)) return 'mean_reversion'
  return 'trend_following'
}

const ALPHA_BUCKETS = new Set<StrategySpec['alphaBucket']>([
  'trend_following',
  'mean_reversion',
  'breakout_vol_expansion',
  'defensive_accumulation',
])

function rawFactorAlphaBucket(candidate: FinLabRawFactorMinerCandidate): StrategySpec['alphaBucket'] {
  const requested = cleanText(candidate.alpha_bucket)
  if (ALPHA_BUCKETS.has(requested as StrategySpec['alphaBucket'])) {
    return requested as StrategySpec['alphaBucket']
  }
  const text = `${candidate.lane ?? ''} ${candidate.dataset_key ?? ''} ${candidate.display_name ?? ''} ${candidate.query ?? ''}`
  if (/volume|成交量|breakout|突破|創高/i.test(text)) return 'breakout_vol_expansion'
  if (/外資|投信|自營商|三大法人|融資|融券|券商|broker|chip|margin/i.test(text)) return 'defensive_accumulation'
  if (/ROE|EPS|本益|淨值|毛利|營益|營收|cash flow|fundamental/i.test(text)) return 'mean_reversion'
  return 'trend_following'
}

function rawFactorThresholds(candidate: FinLabRawFactorMinerCandidate): Partial<StrategySpecThresholds> {
  const lane = cleanText(candidate.lane)
  const text = `${lane} ${candidate.dataset_key ?? ''} ${candidate.display_name ?? ''} ${candidate.query ?? ''}`
  const thresholds: Partial<StrategySpecThresholds> = { minPrice: 10 }
  if (lane === 'technical' || /RSI|MACD|KD|布林|均線|成交量|momentum|volatility|technical|return/i.test(text)) {
    thresholds.minVolumeExpansion20 = 0.75
    thresholds.minCloseAboveMa20Pct = -0.03
    if (/RSI/i.test(text)) {
      thresholds.minTechnicalIndicators = { ...(thresholds.minTechnicalIndicators ?? {}), rsi14: 35 }
    }
  }
  if (lane === 'chip' || /外資|投信|自營商|三大法人|融資|融券|券商|broker|margin|chip/i.test(text)) {
    thresholds.minForeignTrustNet5d = 0
  }
  if (lane === 'fundamental' || /月營收|營收|ROE|EPS|毛利|營益|本益|淨值|cash flow|fundamental/i.test(text)) {
    thresholds.minEps = 0
    thresholds.minRoe = 3
    thresholds.maxPe = 80
  }
  return thresholds
}

function packetFromRawFactorMinerCandidate(
  candidate: FinLabRawFactorMinerCandidate,
  date: string,
  nowIso: string,
  payload: FinLabRawFactorMinerPayload,
): FinLabAiSkillDiscoveryBridgePacket | null {
  const datasetKey = cleanText(candidate.dataset_key)
  if (!datasetKey) return null
  const lane = cleanText(candidate.lane) || 'unknown'
  const displayName = cleanText(candidate.display_name) || datasetKey
  const candidateId = cleanText(candidate.candidate_id) || `${lane}_${datasetKey}`
  const evidenceRequirements = cleanTextArray(candidate.evidence_requirements)
  const minerSourceRefs = cleanTextArray(candidate.source_refs)
  return buildFinLabAiSkillDiscoveryBridgePacket({
    id: `raw_factor_${candidateId}`,
    hypothesis: cleanText(candidate.hypothesis) ||
      `FinLab API raw-factor miner discovered ${lane} dataset "${displayName}" (${datasetKey}); keep it research-only until strategy-learning reward, PBO and reality-check evidence justify promotion.`,
    taxonomyRefs: [`finlab_raw_factor_lane:${lane}`],
    factorRefs: [
      `raw_factor_dataset:${datasetKey}`,
      `raw_factor_lane:${lane}`,
      ...evidenceRequirements,
    ],
    sourceRefs: [
      `run_date:${date}`,
      FINLAB_RAW_FACTOR_MINER_ID,
      payload.version ? `miner_version:${payload.version}` : 'miner_version:unknown',
      payload.generated_at ? `miner_generated_at:${payload.generated_at}` : 'miner_generated_at:unknown',
      payload.checksum ? `miner_checksum:${payload.checksum}` : 'miner_checksum:unknown',
      `dataset:${datasetKey}`,
      `lane:${lane}`,
      `query:${cleanText(candidate.query) || 'unknown'}`,
      `production_effect:${candidate.production_effect === true ? 'true' : 'false'}`,
      ...minerSourceRefs,
    ],
    tag: displayName,
    tagType: `finlab_raw_factor_${lane}`,
    bindTagToIndustry: false,
    alphaBucket: rawFactorAlphaBucket(candidate),
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thresholds: rawFactorThresholds(candidate),
    status: 'research',
    approvedForL1: false,
    metrics: ['finlab_api_search', 'strategy_reward', 'l1_recall', 'ic_4w_avg', 'pbo', 'reality_check'],
    followUp: [
      'materialize historical raw factor panel coverage',
      'run walk-forward reward and PBO before candidate promotion',
      'promote through strategy-learning only after explicit evidence gate',
    ],
    nowIso,
  })
}

export function buildFinLabRawFactorMinerDiscoveryPackets(
  payload: FinLabRawFactorMinerPayload | null | undefined,
  date: string,
  nowIso: string,
  options: { limit?: number } = {},
): FinLabAiSkillDiscoveryBridgePacket[] {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 80), 200))
  return candidates
    .slice(0, limit)
    .map((candidate) => packetFromRawFactorMinerCandidate(candidate, date, nowIso, payload ?? {}))
    .filter((packet): packet is FinLabAiSkillDiscoveryBridgePacket => packet != null)
}

export function officialStrategyPassesDirectActiveGate(strategy: FinLabOfficialStrategySummary): boolean {
  return strategy.market === 'TW'
    && !strategy.tags.includes('ETF')
    && strategy.sharpe_ratio != null
    && strategy.sharpe_ratio > FINLAB_OFFICIAL_DIRECT_ACTIVE_SHARPE_MIN
    && strategy.max_drawdown != null
    && strategy.max_drawdown >= FINLAB_OFFICIAL_DIRECT_ACTIVE_MAX_DRAWDOWN_FLOOR
}

function packetFromOfficialStrategy(
  strategy: FinLabOfficialStrategySummary,
  date: string,
  nowIso: string,
): FinLabAiSkillDiscoveryBridgePacket {
  const directActive = officialStrategyPassesDirectActiveGate(strategy)
  const metrics = [
    strategy.annual_return != null ? `annual_return=${strategy.annual_return.toFixed(4)}` : null,
    strategy.sharpe_ratio != null ? `sharpe=${strategy.sharpe_ratio.toFixed(4)}` : null,
    strategy.max_drawdown != null ? `max_drawdown=${strategy.max_drawdown.toFixed(4)}` : null,
  ].filter(Boolean).join(' ')
  return buildFinLabAiSkillDiscoveryBridgePacket({
    id: `official_${strategy.sid}`,
    hypothesis:
      `FinLab official strategy "${strategy.name}" (${strategy.tags.join('/') || 'untagged'}) was discovered from the official strategy catalog; ` +
      `${metrics || 'performance metrics unavailable'}; convert its published factor family into StockVision raw-signal hypotheses before promotion.`,
    taxonomyRefs: strategy.tags.map((tag) => `finlab_official_tag:${tag}`),
    factorRefs: officialStrategyFactorRefs(strategy),
    sourceRefs: [
      `run_date:${date}`,
      `finlab_official_strategy_page:${FINLAB_OFFICIAL_STRATEGY_PAGE_URL}`,
      `finlab_official_uid:${FINLAB_OFFICIAL_STRATEGY_UID}`,
      `finlab_official_sid:${strategy.sid}`,
      `market:${strategy.market}`,
      `public_code:${strategy.public_code ?? 'unknown'}`,
      `public_position:${strategy.public_position ?? 'unknown'}`,
      directActive
        ? `direct_active_gate:sharpe_gt_${FINLAB_OFFICIAL_DIRECT_ACTIVE_SHARPE_MIN}_max_drawdown_gte_${FINLAB_OFFICIAL_DIRECT_ACTIVE_MAX_DRAWDOWN_FLOOR}`
        : 'direct_active_gate:not_passed',
      strategy.last_updated ? `last_updated:${strategy.last_updated}` : 'last_updated:unknown',
    ],
    tag: strategy.name,
    tagType: 'finlab_official_strategy',
    bindTagToIndustry: false,
    alphaBucket: officialStrategyAlphaBucket(strategy),
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thresholds: officialStrategyThresholds(strategy),
    status: directActive ? 'active' : 'research',
    approvedForL1: directActive,
    metrics: ['official_annual_return', 'official_sharpe', 'official_max_drawdown', 'strategy_reward', 'l1_recall', 'pbo'],
    followUp: directActive
      ? [
        'active by user-approved official FinLab metric gate',
        'monitor StockVision reward, PBO and reality-check evidence for demotion',
        'tighten or retire if live StockVision edge decays',
      ]
      : [
        'fetch official FinLab strategy article/code when permission allows',
        'translate official factor family into raw StockVision factor thresholds',
        'run walk-forward and reality-check evidence before candidate promotion',
      ],
    nowIso,
  })
}

export function buildFinLabOfficialStrategyDiscoveryPackets(
  strategies: FinLabOfficialStrategySummary[],
  date: string,
  nowIso: string,
  options: { market?: 'TW' | 'US' | 'all'; limit?: number } = {},
): FinLabAiSkillDiscoveryBridgePacket[] {
  const market = options.market ?? 'TW'
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 40), 80))
  return strategies
    .filter((strategy) => market === 'all' || strategy.market === market)
    .filter((strategy) => !strategy.tags.includes('ETF'))
    .slice(0, limit)
    .map((strategy) => packetFromOfficialStrategy(strategy, date, nowIso))
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
    factorRefs: ['finlab_taxonomy_breadth', 'raw_factor_mining', 'raw_technical_indicator_mining', 'strategy_reward'],
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
    includeOfficialStrategies?: boolean
    officialStrategyLimit?: number
    officialStrategyMarket?: 'TW' | 'US' | 'all'
    fetcher?: typeof fetch
    rawFactorMinerPayload?: FinLabRawFactorMinerPayload | null
    rawFactorMinerLimit?: number
  } = {},
): Promise<FinLabAiSkillDiscoveryClosureReport> {
  const dryRun = options.dryRun === true
  const limit = Math.max(1, Math.min(Math.round(options.limit ?? 3), 10))
  const minSymbols = Math.max(3, Math.min(Math.round(options.minSymbols ?? 8), 80))
  const nowIso = options.nowIso ?? new Date().toISOString()

  let rows: FinLabTaxonomyDiscoveryRow[] = []
  let officialStrategies: FinLabOfficialStrategySummary[] = []
  const discoveryWarnings: string[] = []
  try {
    rows = await loadFinLabTaxonomyDiscoveryRows(env.DB, date, { limit, minSymbols })
  } catch (error) {
    discoveryWarnings.push(`finlab_taxonomy_unavailable:${String(error).slice(0, 160)}`)
  }

  if (options.includeOfficialStrategies !== false) {
    try {
      officialStrategies = await fetchFinLabOfficialStrategyCatalog({ fetcher: options.fetcher })
    } catch (error) {
      discoveryWarnings.push(`finlab_official_strategy_catalog_unavailable:${String(error).slice(0, 160)}`)
    }
  }

  const taxonomyPackets = rows
    .map((row) => packetFromTaxonomyRow(row, date, nowIso))
    .filter((packet): packet is FinLabAiSkillDiscoveryBridgePacket => packet != null)
  const officialPackets = buildFinLabOfficialStrategyDiscoveryPackets(officialStrategies, date, nowIso, {
    market: options.officialStrategyMarket ?? 'TW',
    limit: options.officialStrategyLimit ?? 40,
  })
  const rawFactorPackets = buildFinLabRawFactorMinerDiscoveryPackets(options.rawFactorMinerPayload, date, nowIso, {
    limit: options.rawFactorMinerLimit ?? 80,
  })
  const rawFactorSourceRows = Array.isArray(options.rawFactorMinerPayload?.candidates)
    ? options.rawFactorMinerPayload.candidates.length
    : 0
  const packets = [...taxonomyPackets, ...officialPackets, ...rawFactorPackets]
  const validPackets = packets.filter((packet) => packet.ok)
  const skippedInvalid = packets
    .filter((packet) => !packet.ok)
    .map((packet) => `${packet.strategy_spec.id}:${packet.errors.join('|')}`)
  skippedInvalid.push(...discoveryWarnings)

  const report: FinLabAiSkillDiscoveryClosureReport = {
    status: dryRun ? 'dry_run' : validPackets.length ? 'persisted' : 'skipped',
    version: FINLAB_AI_SKILL_DISCOVERY_VERSION,
    date,
    source_rows: rows.length + officialStrategies.length + rawFactorSourceRows,
    packets,
    persisted: { research_experiments: 0, strategy_specs: 0 },
    skipped_invalid: skippedInvalid,
    reason: validPackets.length ? undefined : discoveryWarnings.join('|') || 'no_valid_finlab_ai_skill_discoveries',
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
