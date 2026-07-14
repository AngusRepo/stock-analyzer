// Minimal Cloudflare Workers type declarations
// Full types available via: npm i @cloudflare/workers-types

declare interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<D1ExecResult>
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(colName?: string): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
  raw<T = unknown[]>(): Promise<T[]>
}

declare interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: Record<string, unknown>
  error?: string
}

declare interface D1ExecResult {
  count: number
  duration: number
}

declare interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<any>
  get(key: string, type: 'text'): Promise<string | null>
  get(key: string, type: 'json'): Promise<any | null>
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

declare interface ScheduledEvent {
  scheduledTime: number
  cron: string
}

declare interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
  scheduled?(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void>
  queue?<T = unknown>(batch: MessageBatch<T>, env: Env, ctx: ExecutionContext): Promise<void>
}

declare interface WorkflowInstance {
  id: string
  status(): Promise<{ status: string; output?: unknown; error?: unknown }>
  pause?(): Promise<void>
  resume?(): Promise<void>
  restart?(): Promise<void>
  terminate?(): Promise<void>
}

declare interface WorkflowBinding<Params = unknown> {
  create(options?: { id?: string; params?: Params }): Promise<WorkflowInstance>
  get(id: string): Promise<WorkflowInstance>
}

declare module 'cloudflare:workers' {
  export interface WorkflowEvent<Params = unknown> { payload: Params; instanceId: string; timestamp: Date }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>
    do<T>(name: string, config: { retries?: { limit: number; delay: string; backoff?: 'constant' | 'linear' | 'exponential' }; timeout?: string }, callback: () => Promise<T>): Promise<T>
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env
    protected ctx: ExecutionContext
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>
  }
}

// ─── Queue Types ─────────────────────────────────────────────────────────────

declare interface Queue<T = unknown> {
  send(message: T, options?: { contentType?: string }): Promise<void>
  sendBatch(messages: { body: T; contentType?: string }[]): Promise<void>
}

declare interface MessageBatch<T = unknown> {
  readonly queue: string
  readonly messages: Message<T>[]
  ackAll(): void
  retryAll(): void
}

declare interface Message<T = unknown> {
  readonly id: string
  readonly timestamp: Date
  readonly body: T
  ack(): void
  retry(): void
}

