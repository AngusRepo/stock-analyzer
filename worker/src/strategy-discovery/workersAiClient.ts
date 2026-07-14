import { MODEL_REGISTRY, STRATEGY_DISCOVERY_PROMPT_VERSION, STRATEGY_DISCOVERY_SCHEMA_VERSION, type ModelEndpointConfig, type ModelRole } from './config'
import { hashJson } from './hashing'
import type { ModelCallResult } from './domain'
import type { StrategyDiscoveryArtifacts } from './artifacts'
import type { ModelCallRecord, StrategyDiscoveryRepository } from './repositories'

export interface JsonSchemaDefinition { name: string; schema: Record<string, unknown> }

export interface WorkersAiInvocation<T> {
  runId: string
  stepId: string
  role: ModelRole
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  outputSchema: JsonSchemaDefinition
  validate: (value: unknown) => { ok: boolean; value?: T; errors: string[] }
  fixture?: T
  maxTokens?: number
}

type RepositoryPort = Pick<StrategyDiscoveryRepository, 'recordModelCall'>
type ArtifactPort = Pick<StrategyDiscoveryArtifacts, 'putJson'>

function usageValue(response: any, keys: string[]): number {
  for (const key of keys) {
    const value = Number(response?.usage?.[key] ?? response?.[key])
    if (Number.isFinite(value) && value >= 0) return Math.floor(value)
  }
  return 0
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim()
  try { return JSON.parse(trimmed) } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1].trim()) } catch {}
  }
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) } catch {}
  }
  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1)) } catch {}
  }
  return value
}

function responseValue(response: any): unknown {
  // Native Workers AI responses are model-specific: most models expose
  // `response`, while GPT-OSS uses an OpenAI-compatible transport envelope.
  // This only unwraps transport/formatting; the strict role schema remains the
  // authority immediately after normalization.
  const value = response?.response
    ?? response?.result
    ?? response?.choices?.[0]?.message?.content
    ?? response
  return typeof value === 'string' ? parseJsonText(value) : value
}

function repairCandidate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const nested = (value as Record<string, unknown>).raw
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : value
}

function requestFor(config: ModelEndpointConfig, messages: WorkersAiInvocation<unknown>['messages'], outputSchema: JsonSchemaDefinition, maxTokens?: number): Record<string, unknown> {
  const structured = config.structuredMode === 'guided_json'
    ? { guided_json: outputSchema.schema }
    : config.structuredMode === 'json_object'
      ? { response_format: { type: 'json_object' } }
      : { response_format: { type: 'json_schema', json_schema: outputSchema.schema } }
  const effectiveMessages = config.structuredMode === 'json_object'
    ? [{ role: 'system' as const, content: `Return exactly one JSON object matching this trusted output schema. Do not echo the schema: ${JSON.stringify(outputSchema.schema)}` }, ...messages]
    : messages
  return { messages: effectiveMessages, max_tokens: maxTokens ?? config.outputTokenCap, temperature: 0.1,
    ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}), ...structured }
}

function estimatedNeurons(config: ModelEndpointConfig, promptTokens: number, outputTokens: number): number {
  return Math.ceil(promptTokens * config.inputNeuronsPerMillion / 1_000_000 + outputTokens * config.outputNeuronsPerMillion / 1_000_000)
}

function mayFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:3043|3046|internal server|504|gateway|timeout|unavailable|capacity)/i.test(message)
}

export class StrategyDiscoveryWorkersAiClient {
  constructor(
    private readonly ai: { run(model: string, request: Record<string, unknown>): Promise<unknown> } | undefined,
    private readonly repository: RepositoryPort,
    private readonly artifacts: ArtifactPort,
    private readonly fixtureMode: boolean,
  ) {}

  async invoke<T>(input: WorkersAiInvocation<T>): Promise<ModelCallResult<T>> {
    const config = MODEL_REGISTRY[input.role]
    const promptBytes = input.messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0)
    if (promptBytes > config.inputTokenCap * 3) throw new Error(`model_prompt_byte_guard_exceeded:${input.role}:${promptBytes}:${config.inputTokenCap * 3}`)
    const callId = `${input.runId}:${input.stepId}:${input.role}:${crypto.randomUUID().slice(0, 8)}`
    const artifactToken = `${input.stepId}-${input.role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`
    const startedAt = new Date().toISOString()
    const inputHash = await hashJson({ role: input.role, messages: input.messages, schema: input.outputSchema })
    let raw: unknown = this.fixtureMode ? input.fixture : undefined
    let parsed: T | undefined
    let repairCount = 0
    let promptTokens = 0
    let outputTokens = 0
    let errorCode: string | null = null
    let validationStatus = 'FAILED'
    let activeConfig: ModelEndpointConfig = config
    let usedFallback = false
    const rawAttempts: Array<{ kind: 'fixture' | 'primary' | 'fallback' | 'repair'; model_id: string; transport_response: unknown; normalized_response: unknown }> = []
    try {
      if (this.fixtureMode) {
        if (input.fixture === undefined) throw new Error(`fixture_missing:${input.role}`)
        rawAttempts.push({ kind: 'fixture', model_id: config.model, transport_response: input.fixture, normalized_response: input.fixture })
      } else {
        if (!this.ai) throw new Error('workers_ai_binding_missing')
        let response: unknown
        let attemptKind: 'primary' | 'fallback' = 'primary'
        try { response = await this.ai.run(config.model, requestFor(config, input.messages, input.outputSchema, input.maxTokens)) }
        catch (error) {
          if (!config.fallback || !mayFallback(error)) throw error
          activeConfig = config.fallback
          usedFallback = true
          attemptKind = 'fallback'
          response = await this.ai.run(activeConfig.model, requestFor(activeConfig, input.messages, input.outputSchema, input.maxTokens))
        }
        raw = responseValue(response)
        rawAttempts.push({ kind: attemptKind, model_id: activeConfig.model, transport_response: response, normalized_response: raw })
        promptTokens += usageValue(response, ['prompt_tokens', 'input_tokens'])
        outputTokens += usageValue(response, ['completion_tokens', 'output_tokens'])
        if (promptTokens > activeConfig.inputTokenCap) throw new Error(`model_prompt_token_cap_exceeded:${input.role}:${promptTokens}:${activeConfig.inputTokenCap}`)
      }
      let validation = input.validate(raw)
      if (!validation.ok && !this.fixtureMode && config.fallback && !usedFallback) {
        activeConfig = config.fallback
        usedFallback = true
        const fallbackResponse = await this.ai!.run(activeConfig.model, requestFor(activeConfig, input.messages, input.outputSchema, input.maxTokens))
        raw = responseValue(fallbackResponse)
        rawAttempts.push({ kind: 'fallback', model_id: activeConfig.model, transport_response: fallbackResponse, normalized_response: raw })
        promptTokens += usageValue(fallbackResponse, ['prompt_tokens', 'input_tokens'])
        outputTokens += usageValue(fallbackResponse, ['completion_tokens', 'output_tokens'])
        validation = input.validate(raw)
      }
      if (!validation.ok && !this.fixtureMode) {
        repairCount = 1
        const repairMessages: WorkersAiInvocation<unknown>['messages'] = [
          { role: 'system', content: 'You only repair JSON shape. Preserve claims and values. Return schema-valid JSON only.' },
          { role: 'user', content: JSON.stringify({ validation_errors: validation.errors, schema: input.outputSchema.schema, raw }).slice(0, 24_000) },
        ]
        const repaired = await this.ai!.run(activeConfig.model, requestFor(activeConfig, repairMessages, input.outputSchema, Math.min(input.maxTokens ?? 700, 700, activeConfig.outputTokenCap)))
        const normalizedRepair = responseValue(repaired)
        raw = repairCandidate(normalizedRepair)
        rawAttempts.push({ kind: 'repair', model_id: activeConfig.model, transport_response: repaired, normalized_response: normalizedRepair })
        promptTokens += usageValue(repaired, ['prompt_tokens', 'input_tokens'])
        outputTokens += usageValue(repaired, ['completion_tokens', 'output_tokens'])
        validation = input.validate(raw)
      }
      if (!validation.ok || validation.value === undefined) throw new Error(`model_schema_validation_failed:${input.role}:${validation.errors.join(',')}`)
      parsed = validation.value
      validationStatus = 'VALID'
    } catch (error) {
      errorCode = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      throw error
    } finally {
      const endedAt = new Date().toISOString()
      const sourceType = this.fixtureMode ? 'FIXTURE' as const : 'REAL' as const
      let rawArtifact: Awaited<ReturnType<ArtifactPort['putJson']>> | null = null
      let parsedArtifact: Awaited<ReturnType<ArtifactPort['putJson']>> | null = null
      let artifactFailure: unknown = null
      try {
        rawArtifact = await this.artifacts.putJson(input.runId, `model-raw-${artifactToken}`, { attempts: rawAttempts, final_normalized: raw }, { call_id: callId, role: input.role, source_type: sourceType })
        parsedArtifact = parsed === undefined ? null : await this.artifacts.putJson(input.runId, `model-parsed-${artifactToken}`, parsed, { call_id: callId, role: input.role, source_type: sourceType })
      } catch (error) { artifactFailure = error }
      const record: ModelCallRecord = {
        call_id: callId, run_id: input.runId, step_id: input.stepId, model_id: activeConfig.model, role: input.role,
        model_version: usedFallback ? `cloudflare-model-registry-v1:fallback-from:${config.model}` : 'cloudflare-model-registry-v1', prompt_version: STRATEGY_DISCOVERY_PROMPT_VERSION,
        schema_version: STRATEGY_DISCOVERY_SCHEMA_VERSION, input_hash: inputHash,
        raw_response_r2_key: rawArtifact?.key ?? null, parsed_response_r2_key: parsedArtifact?.key ?? null,
        prompt_tokens: promptTokens, output_tokens: outputTokens, estimated_neurons: this.fixtureMode ? 0 : estimatedNeurons(activeConfig, promptTokens, outputTokens),
        started_at: startedAt, ended_at: endedAt, retry_count: 0, repair_count: repairCount,
        validation_status: validationStatus, source_type: sourceType, error_code: errorCode,
      }
      await this.repository.recordModelCall(record)
      if (artifactFailure) throw artifactFailure
    }
    return { parsed: parsed!, raw: { attempts: rawAttempts, final_normalized: raw }, model_id: activeConfig.model,
      model_version: usedFallback ? `cloudflare-model-registry-v1:fallback-from:${config.model}` : 'cloudflare-model-registry-v1',
      prompt_tokens: promptTokens, output_tokens: outputTokens,
      estimated_neurons: this.fixtureMode ? 0 : estimatedNeurons(activeConfig, promptTokens, outputTokens), repair_count: repairCount,
      source_type: this.fixtureMode ? 'FIXTURE' : 'REAL' }
  }
}
