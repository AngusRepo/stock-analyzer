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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optionalIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt: number): number {
  return Math.min(500 * (2 ** attempt), 4000) + Math.floor(Math.random() * 250)
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
