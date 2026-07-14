import type { SearchMode } from './domain'

export const STRATEGY_DISCOVERY_SCHEMA_VERSION = 'strategy-discovery-schema-v1'
export const STRATEGY_DISCOVERY_PROMPT_VERSION = 'strategy-discovery-prompts-v1'
export const EXPECTED_STRATEGY_COUNT = 13
export const EXPECTED_FEATURE_COUNT = 137

export const SEARCH_POLICY: Readonly<{ candidate_count: 12; allocation: Record<SearchMode, number> }> = {
  candidate_count: 12,
  allocation: {
    MODE_C_PORTFOLIO_GAP: 6,
    MODE_B_PARENT_MUTATION: 4,
    MODE_D_REGIME_SPECIALIST: 2,
    MODE_A_FREE_DISCOVERY: 0,
  },
}

export const AI_BUDGET = {
  dailyHardLimit: 10_000,
  dailySoftLimit: 8_000,
  minimumReserve: 2_000,
  estimatedRunNeurons: 1_824,
  estimationMarginNeurons: 456,
  preflightReservationNeurons: 2_280,
} as const

export type ModelRole =
  | 'FEATURE_LIBRARIAN'
  | 'HYPOTHESIS_SCIENTIST'
  | 'REGIME_EXPLORER'
  | 'EXECUTION_ARCHITECT'
  | 'PORTFOLIO_JUDGE'
  | 'DATA_PROSECUTOR'
  | 'EXECUTION_PROSECUTOR'
  | 'ECONOMIC_PROSECUTOR'
  | 'CROSS_EXAMINER'

export interface ModelEndpointConfig {
  model: string
  inputTokenCap: number
  outputTokenCap: number
  inputNeuronsPerMillion: number
  outputNeuronsPerMillion: number
  structuredMode: 'response_format' | 'guided_json' | 'json_object'
  reasoningEffort?: 'low'
}
export interface ModelConfig extends ModelEndpointConfig {
  role: ModelRole
  fallback?: ModelEndpointConfig
}

const QWEN_FALLBACK: ModelEndpointConfig = {
  model: '@cf/qwen/qwen3-30b-a3b-fp8', inputTokenCap: 8_000, outputTokenCap: 3_500,
  inputNeuronsPerMillion: 4_625, outputNeuronsPerMillion: 30_475, structuredMode: 'json_object',
}

export const MODEL_REGISTRY: Readonly<Record<ModelRole, ModelConfig>> = {
  FEATURE_LIBRARIAN: { role: 'FEATURE_LIBRARIAN', model: '@cf/qwen/qwen3-30b-a3b-fp8', inputTokenCap: 8_000, outputTokenCap: 1_500, inputNeuronsPerMillion: 4_625, outputNeuronsPerMillion: 30_475, structuredMode: 'response_format' },
  HYPOTHESIS_SCIENTIST: { role: 'HYPOTHESIS_SCIENTIST', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', inputTokenCap: 7_000, outputTokenCap: 2_200, inputNeuronsPerMillion: 31_876, outputNeuronsPerMillion: 50_488, structuredMode: 'guided_json', fallback: { ...QWEN_FALLBACK, outputTokenCap: 2_200 } },
  REGIME_EXPLORER: { role: 'REGIME_EXPLORER', model: '@cf/google/gemma-4-26b-a4b-it', inputTokenCap: 6_000, outputTokenCap: 1_500, inputNeuronsPerMillion: 9_091, outputNeuronsPerMillion: 27_273, structuredMode: 'response_format', reasoningEffort: 'low', fallback: { ...QWEN_FALLBACK, outputTokenCap: 1_500 } },
  EXECUTION_ARCHITECT: { role: 'EXECUTION_ARCHITECT', model: '@cf/zai-org/glm-4.7-flash', inputTokenCap: 8_000, outputTokenCap: 3_500, inputNeuronsPerMillion: 5_500, outputNeuronsPerMillion: 36_400, structuredMode: 'response_format', reasoningEffort: 'low', fallback: QWEN_FALLBACK },
  PORTFOLIO_JUDGE: { role: 'PORTFOLIO_JUDGE', model: '@cf/openai/gpt-oss-120b', inputTokenCap: 10_000, outputTokenCap: 2_500, inputNeuronsPerMillion: 31_818, outputNeuronsPerMillion: 68_182, structuredMode: 'response_format' },
  DATA_PROSECUTOR: { role: 'DATA_PROSECUTOR', model: '@cf/qwen/qwen3-30b-a3b-fp8', inputTokenCap: 8_000, outputTokenCap: 1_500, inputNeuronsPerMillion: 4_625, outputNeuronsPerMillion: 30_475, structuredMode: 'response_format' },
  EXECUTION_PROSECUTOR: { role: 'EXECUTION_PROSECUTOR', model: '@cf/zai-org/glm-4.7-flash', inputTokenCap: 8_000, outputTokenCap: 1_500, inputNeuronsPerMillion: 5_500, outputNeuronsPerMillion: 36_400, structuredMode: 'response_format', reasoningEffort: 'low', fallback: { ...QWEN_FALLBACK, outputTokenCap: 1_500 } },
  ECONOMIC_PROSECUTOR: { role: 'ECONOMIC_PROSECUTOR', model: '@cf/google/gemma-4-26b-a4b-it', inputTokenCap: 8_000, outputTokenCap: 1_500, inputNeuronsPerMillion: 9_091, outputNeuronsPerMillion: 27_273, structuredMode: 'response_format', reasoningEffort: 'low', fallback: { ...QWEN_FALLBACK, outputTokenCap: 1_500 } },
  CROSS_EXAMINER: { role: 'CROSS_EXAMINER', model: '@cf/mistralai/mistral-small-3.1-24b-instruct', inputTokenCap: 8_000, outputTokenCap: 2_000, inputNeuronsPerMillion: 31_876, outputNeuronsPerMillion: 50_488, structuredMode: 'guided_json', fallback: { ...QWEN_FALLBACK, outputTokenCap: 2_000 } },
}

export const WORKFLOW_STEPS = [
  '01_preflight',
  '02_freeze_snapshot',
  '03_feature_intelligence',
  '04_portfolio_gap_map',
  '05_hypothesis_generation',
  '06_strategy_dsl',
  '07_static_validation',
  '08_candidate_shortlist',
  '09_specialist_red_team',
  '10_cross_examination',
  '11_cloud_report_and_bundle',
  '12_complete',
] as const

export const ZIP_LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024,
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxPathLength: 240,
} as const

export function isLocalFixtureModeAuthorized(env: {
  ENVIRONMENT?: unknown
  LOCAL_AUTH_BYPASS?: unknown
  STRATEGY_DISCOVERY_FIXTURE_MODE?: unknown
}): boolean {
  const environment = String(env.ENVIRONMENT ?? '').trim().toLowerCase()
  const localAuthBypass = String(env.LOCAL_AUTH_BYPASS ?? '').trim().toLowerCase()
  return environment === 'local' && ['1', 'true'].includes(localAuthBypass)
}

export function estimateNeurons(role: ModelRole, promptTokens: number, outputTokens: number): number {
  const cfg = MODEL_REGISTRY[role]
  return Math.ceil(
    promptTokens * cfg.inputNeuronsPerMillion / 1_000_000
    + outputTokens * cfg.outputNeuronsPerMillion / 1_000_000,
  )
}

export function canReserveAnalysis(knownUsed: number, externalReserved: number): boolean {
  return knownUsed + externalReserved + AI_BUDGET.preflightReservationNeurons <= AI_BUDGET.dailySoftLimit
}
