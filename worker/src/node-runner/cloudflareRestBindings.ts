import { allocatorContractGuardEnabled } from './allocatorContractGuard'
import type {
  EvidenceArtifactManifest,
  EvidenceArtifactWriteInput,
  EvidenceArtifactWriter,
} from '../lib/evidenceArtifactContract'
import { sha256Text } from '../lib/datasetSnapshots'

type D1RestResponse = {
  success?: boolean
  result?: Array<{
    success?: boolean
    results?: any[] | { columns?: string[]; rows?: any[][] }
    meta?: Record<string, unknown>
    error?: string
  }>
  errors?: unknown
}

type D1RestConfig = {
  accountId: string
  databaseId: string
  apiToken: string
  maxRetries: number
}

type KVRestConfig = {
  accountId: string
  namespaceId: string
  apiToken: string
  maxRetries: number
}

type EvidenceArtifactWriterConfig = {
  workerUrl: string
  serviceToken: string
  maxRetries: number
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const SCREENER_ARTIFACT_DIRECT_WRITE_MAX_BYTES = 2 * 1024 * 1024
const SCREENER_ARTIFACT_CHUNK_TARGET_BYTES = 1536 * 1024
const SCREENER_ARTIFACT_CHUNK_SCHEMA = 'screener-funnel-evidence-chunk-v1'
const SCREENER_ARTIFACT_INDEX_SCHEMA = 'screener-funnel-evidence-index-v1'
const SCREENER_ARTIFACT_CHUNK_DOMAIN = 'screener_funnel_chunk'
const SCREENER_ARTIFACT_LOGICAL_SCHEMAS = new Set([
  'screener-funnel-evidence-v2',
  'screener-funnel-evidence-v3',
])

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optionalIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function requiredWorkerUrl(name: string): string {
  const raw = requiredEnv(name)
  const parsed = new URL(raw)
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS outside localhost`)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt: number): number {
  return Math.min(500 * (2 ** attempt), 4000) + Math.floor(Math.random() * 250)
}

function firstSqlToken(sql: string): string {
  return sql.trim().replace(/^--.*(?:\r?\n|$)/, '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

function isMutatingSql(sql: string): boolean {
  return new Set(['alter', 'create', 'delete', 'drop', 'insert', 'replace', 'truncate', 'update', 'vacuum'])
    .has(firstSqlToken(sql))
}

function noopD1Result<T>(changes = 1): D1Result<T> {
  return {
    results: [],
    success: true,
    meta: {
      changes,
      rows_written: changes,
      duration: 0,
      timings: { sql_duration_ms: 0 },
      allocator_contract_noop: true,
    },
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= maxRetries) return res
      await sleep(retryDelayMs(attempt))
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries) break
      await sleep(retryDelayMs(attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'fetch failed'))
}

export class RestEvidenceArtifactWriter implements EvidenceArtifactWriter {
  constructor(private readonly config: EvidenceArtifactWriterConfig) {}

  static fromEnv(): RestEvidenceArtifactWriter {
    return new RestEvidenceArtifactWriter({
      workerUrl: requiredWorkerUrl('STOCKVISION_WORKER_URL'),
      serviceToken: requiredEnv('STOCKVISION_AUTH_TOKEN'),
      maxRetries: optionalIntEnv('ARTIFACT_WRITER_MAX_RETRIES', 3),
    })
  }

  private async post(input: EvidenceArtifactWriteInput): Promise<EvidenceArtifactManifest> {
    const response = await fetchWithRetry(
      `${this.config.workerUrl}/api/internal/evidence-artifacts/screener-funnel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.serviceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
      this.config.maxRetries,
    )
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Evidence artifact writer HTTP ${response.status}: ${text.slice(0, 300)}`)
    }
    const payload = JSON.parse(text) as { ok?: boolean; manifest?: EvidenceArtifactManifest }
    const manifest = payload.manifest
    if (
      !payload.ok
      || !manifest
      || manifest.status !== 'ready'
      || manifest.domain !== input.domain
      || manifest.schema_version !== input.schemaVersion
      || manifest.row_count !== input.rowCount
      || !manifest.artifact_id
      || !manifest.r2_key
      || !/^sha256:[a-f0-9]{64}$/i.test(manifest.checksum)
    ) {
      throw new Error(`Evidence artifact writer returned invalid manifest: ${text.slice(0, 300)}`)
    }
    return manifest
  }

  private partitionScreenerItems(items: unknown[]): unknown[][] {
    const chunks: unknown[][] = []
    let current: unknown[] = []
    let currentBytes = 0
    for (const item of items) {
      const itemBytes = utf8ByteLength(JSON.stringify(item)) + 1
      if (itemBytes > SCREENER_ARTIFACT_CHUNK_TARGET_BYTES) {
        throw new Error(`screener_funnel_item_exceeds_transport_limit:${itemBytes}`)
      }
      if (current.length && currentBytes + itemBytes > SCREENER_ARTIFACT_CHUNK_TARGET_BYTES) {
        chunks.push(current)
        current = []
        currentBytes = 0
      }
      current.push(item)
      currentBytes += itemBytes
    }
    if (current.length) chunks.push(current)
    return chunks
  }

  private async writeChunkedScreener(
    input: EvidenceArtifactWriteInput,
    items: unknown[],
  ): Promise<EvidenceArtifactManifest> {
    const chunks = this.partitionScreenerItems(items)
    const chunkManifests: Array<Record<string, unknown>> = []
    let rowOffset = 0
    for (let index = 0; index < chunks.length; index++) {
      const chunkItems = chunks[index]
      const chunkInput: EvidenceArtifactWriteInput = {
        ...input,
        domain: SCREENER_ARTIFACT_CHUNK_DOMAIN,
        schemaVersion: SCREENER_ARTIFACT_CHUNK_SCHEMA,
        payload: {
          storage_mode: 'chunked_r2_child_v1',
          logical_domain: input.domain,
          logical_schema_version: input.schemaVersion,
          chunk_index: index,
          chunk_count: chunks.length,
          row_start: rowOffset,
          row_end_exclusive: rowOffset + chunkItems.length,
          items: chunkItems,
        },
        rowCount: chunkItems.length,
        metadata: {
          ...(input.metadata ?? {}),
          parent_producer_run_id: input.producerRunId,
          chunk_index: index,
          chunk_count: chunks.length,
        },
      }
      const serializedBytes = utf8ByteLength(JSON.stringify(chunkInput))
      if (serializedBytes > SCREENER_ARTIFACT_DIRECT_WRITE_MAX_BYTES) {
        throw new Error(`screener_funnel_chunk_exceeds_transport_limit:${serializedBytes}`)
      }
      const manifest = await this.post(chunkInput)
      chunkManifests.push({
        chunk_index: index,
        row_start: rowOffset,
        row_end_exclusive: rowOffset + chunkItems.length,
        artifact_id: manifest.artifact_id,
        r2_key: manifest.r2_key,
        checksum: manifest.checksum,
        row_count: manifest.row_count,
        byte_size: manifest.byte_size,
        schema_version: manifest.schema_version,
      })
      rowOffset += chunkItems.length
    }
    if (rowOffset !== items.length) {
      throw new Error(`screener_funnel_chunk_row_count_mismatch:${rowOffset}:${items.length}`)
    }

    const { items: _items, ...payloadHeader } = input.payload as Record<string, unknown> & { items: unknown[] }
    const logicalPayloadChecksum = await sha256Text(JSON.stringify(input.payload))
    return this.post({
      ...input,
      schemaVersion: SCREENER_ARTIFACT_INDEX_SCHEMA,
      payload: {
        storage_mode: 'chunked_r2_manifest_v1',
        logical_schema_version: input.schemaVersion,
        logical_payload_checksum: logicalPayloadChecksum,
        payload_header: payloadHeader,
        item_count: items.length,
        chunks: chunkManifests,
      },
      metadata: {
        ...(input.metadata ?? {}),
        artifact_transport: {
          mode: 'chunked_r2_manifest_v1',
          chunk_count: chunkManifests.length,
          logical_schema_version: input.schemaVersion,
        },
      },
    })
  }

  async write(input: EvidenceArtifactWriteInput): Promise<EvidenceArtifactManifest> {
    const items = input.domain === 'screener_funnel'
      && SCREENER_ARTIFACT_LOGICAL_SCHEMAS.has(input.schemaVersion)
      && Array.isArray(input.payload?.items)
      ? input.payload.items
      : null
    if (items && input.rowCount !== items.length) {
      throw new Error(`screener_funnel_row_count_mismatch:${input.rowCount}:${items.length}`)
    }
    const serializedBytes = utf8ByteLength(JSON.stringify(input))
    if (items && serializedBytes > SCREENER_ARTIFACT_DIRECT_WRITE_MAX_BYTES) {
      return this.writeChunkedScreener(input, items)
    }
    return this.post(input)
  }
}

class RestD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: RestD1Database,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new RestD1PreparedStatement(this.db, this.sql, values)
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const result = await this.all<Record<string, unknown>>()
    const row = result.results?.[0] ?? null
    if (!row) return null
    if (colName) return ((row as Record<string, unknown>)[colName] as T) ?? null
    return row as T
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this.sql, this.params)
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this.sql, this.params)
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.db.executeRaw<T>(this.sql, this.params)
  }
}

function queryRows<T>(rows: any[] | { columns?: string[]; rows?: any[][] } | undefined): T[] {
  return Array.isArray(rows) ? rows as T[] : []
}

function rawRows<T>(rows: any[] | { columns?: string[]; rows?: any[][] } | undefined): T[] {
  if (Array.isArray(rows)) return rows as T[]
  return Array.isArray(rows?.rows) ? rows.rows as T[] : []
}

export class RestD1Database implements D1Database {
  private readonly baseUrl: string

  constructor(private readonly config: D1RestConfig) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`
  }

  static fromEnv(): RestD1Database {
    return new RestD1Database({
      accountId: requiredEnv('CF_ACCOUNT_ID'),
      databaseId: requiredEnv('CF_D1_DB_ID'),
      apiToken: requiredEnv('CF_API_TOKEN'),
      maxRetries: optionalIntEnv('D1_CLIENT_MAX_RETRIES', 3),
    })
  }

  prepare(query: string): D1PreparedStatement {
    return new RestD1PreparedStatement(this, query)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return []
    if (allocatorContractGuardEnabled()) {
      console.warn(`[AllocatorContractGuard] D1 batch() no-op statements=${statements.length}`)
      return statements.map(() => noopD1Result<T>(1))
    }
    const chunkSize = Math.max(1, Math.min(optionalIntEnv('SCREENER_D1_RAW_BATCH_SIZE', 250), 500))
    const out: D1Result<T>[] = []
    for (let i = 0; i < statements.length; i += chunkSize) {
      const chunk = statements.slice(i, i + chunkSize)
      const payload = {
        batch: chunk.map((statement) => {
          const restStatement = statement as unknown as { sql?: string; params?: unknown[] }
          if (!restStatement.sql) {
            throw new Error('RestD1Database.batch received a non-REST prepared statement')
          }
          return { sql: restStatement.sql, params: restStatement.params ?? [] }
        }),
      }
      const data = await this.postQuery(payload)
      const results = data.result ?? []
      for (let idx = 0; idx < chunk.length; idx++) {
        const item = results[idx] ?? { success: false, error: 'missing D1 batch result' }
        out.push({
          results: queryRows<T>(item.results),
          success: item.success !== false,
          meta: item.meta ?? {},
          error: item.error,
        })
      }
    }
    return out
  }

  async exec(query: string): Promise<D1ExecResult> {
    const result = await this.execute(query, [])
    return {
      count: Number(result.meta?.changes ?? result.meta?.rows_written ?? 0),
      duration: Number((result.meta?.timings as any)?.sql_duration_ms ?? result.meta?.duration ?? 0),
    }
  }

  async execute<T = unknown>(sql: string, params: unknown[]): Promise<D1Result<T>> {
    if (allocatorContractGuardEnabled() && isMutatingSql(sql)) {
      console.warn(`[AllocatorContractGuard] D1 execute() no-op op=${firstSqlToken(sql)}`)
      return noopD1Result<T>(1)
    }
    const data = await this.postQuery({ sql, params })
    const item = data.result?.[0] ?? {}
    return {
      results: queryRows<T>(item.results),
      success: item.success !== false,
      meta: item.meta ?? {},
      error: item.error,
    }
  }

  async executeRaw<T = unknown[]>(sql: string, params: unknown[]): Promise<T[]> {
    const data = await this.postRaw({ sql, params })
    const item = data.result?.[0] ?? {}
    if (item.success === false) throw new Error(`D1 raw query unsuccessful: ${item.error ?? 'unknown error'}`)
    return rawRows<T>(item.results)
  }

  private async postQuery(body: Record<string, unknown>): Promise<D1RestResponse> {
    return this.postJson(`${this.baseUrl}/query`, body)
  }

  private async postRaw(body: Record<string, unknown>): Promise<D1RestResponse> {
    return this.postJson(`${this.baseUrl}/raw`, body)
  }

  private async postJson(url: string, body: Record<string, unknown>): Promise<D1RestResponse> {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, this.config.maxRetries)
    const text = await res.text()
    if (!res.ok) throw new Error(`D1 REST HTTP ${res.status}: ${text.slice(0, 300)}`)
    const data = JSON.parse(text) as D1RestResponse
    if (!data.success) throw new Error(`D1 REST unsuccessful: ${JSON.stringify(data.errors ?? data).slice(0, 300)}`)
    return data
  }
}

export class RestKVNamespace implements KVNamespace {
  private readonly baseUrl: string

  constructor(private readonly config: KVRestConfig) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`
  }

  static fromEnv(): RestKVNamespace {
    return new RestKVNamespace({
      accountId: requiredEnv('CF_ACCOUNT_ID'),
      namespaceId: requiredEnv('CF_KV_NAMESPACE_ID'),
      apiToken: requiredEnv('CF_API_TOKEN'),
      maxRetries: optionalIntEnv('KV_CLIENT_MAX_RETRIES', 3),
    })
  }

  async get(key: string, optionsOrType?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' } | 'text' | 'json'): Promise<any> {
    const type = typeof optionsOrType === 'string' ? optionsOrType : optionsOrType?.type ?? 'text'
    const res = await fetchWithRetry(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    }, this.config.maxRetries)
    if (res.status === 404) return null
    const value = type === 'arrayBuffer'
      ? await res.arrayBuffer()
      : await res.text()
    if (!res.ok) throw new Error(`KV get HTTP ${res.status}: ${String(value).slice(0, 300)}`)
    if (type === 'json') {
      if (typeof value !== 'string' || !value.trim()) return null
      return JSON.parse(value)
    }
    return value
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
  ): Promise<void> {
    if (allocatorContractGuardEnabled()) {
      console.warn(`[AllocatorContractGuard] KV put() no-op key=${key}`)
      return
    }
    const params = new URLSearchParams()
    if (options?.expirationTtl) params.set('expiration_ttl', String(options.expirationTtl))
    if (options?.expiration) params.set('expiration', String(options.expiration))
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const body = typeof value === 'string' || value instanceof ArrayBuffer
      ? value
      : await new Response(value).arrayBuffer()
    const res = await fetchWithRetry(`${this.baseUrl}/values/${encodeURIComponent(key)}${suffix}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
      body,
    }, this.config.maxRetries)
    const text = await res.text()
    if (!res.ok) throw new Error(`KV put HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  async delete(key: string): Promise<void> {
    if (allocatorContractGuardEnabled()) {
      console.warn(`[AllocatorContractGuard] KV delete() no-op key=${key}`)
      return
    }
    const res = await fetchWithRetry(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    }, this.config.maxRetries)
    if (res.status === 404) return
    const text = await res.text()
    if (!res.ok) throw new Error(`KV delete HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const params = new URLSearchParams()
    if (options?.prefix) params.set('prefix', options.prefix)
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.cursor) params.set('cursor', options.cursor)
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const res = await fetchWithRetry(`${this.baseUrl}/keys${suffix}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.config.apiToken}` },
    }, this.config.maxRetries)
    const text = await res.text()
    if (!res.ok) throw new Error(`KV list HTTP ${res.status}: ${text.slice(0, 300)}`)
    const data = JSON.parse(text) as {
      success?: boolean
      result?: { keys?: { name: string }[]; list_complete?: boolean; cursor?: string }
      errors?: unknown
    }
    if (!data.success) throw new Error(`KV list unsuccessful: ${JSON.stringify(data.errors ?? data).slice(0, 300)}`)
    return {
      keys: data.result?.keys ?? [],
      list_complete: Boolean(data.result?.list_complete),
      cursor: data.result?.cursor,
    }
  }
}

export function createNoopQueue(): Queue<any> {
  return {
    async send(): Promise<void> {},
    async sendBatch(): Promise<void> {},
  }
}
