/** stockvision-monitoring: read-only JSON for Grafana (Infinity datasource).
 * GET only (405) → Cloudflare Access JWT (403) → Bearer (401) → route → cache (state 30 s, timeline and slow reads 300 s,
 * the p4 roster, OPB and KV drift reads 900-3600 s).
 * The cache is MONITORING_CACHE (memory + KV, kvCache.ts) when bound, as on workers.dev; otherwise the Cache API.
 * Every response carries generated_at and rows_read (sum of D1 meta.rows_read of the reads behind it). */
import { authorize } from './auth'
import { capacityReport } from './capacity'
import { chainAlertsReport, chainHistoryReport, chainStateReport, chainTimelineReport, isoStamp } from './chain'
import { dataReadinessReport } from './dataReadiness'
import { readOnlyEnv, isIsoDate, twDate, type Memo, type MonitoringEnv } from './env'
import { CHAIN_IDS, isChainId, type ChainId } from './judgment/chainCatalog'
import { evidenceClocksReport } from './evidenceClocks'
import { ReadLedger, type ExecutedQuery } from './readOnlyD1'
import { kvCache } from './kvCache'
import { modelRosterReport } from './modelRoster'
import { opbReport } from './opb'
import { paperNavReport } from './paperNav'
import { failureClassesReport, kvDriftReport } from './schedulerTickets'
import { isTradingDay } from './tradingDay'

/** D11: state-type 30 s, timeline-type 300 s. */
export const STATE_TTL_S = 30
export const TIMELINE_TTL_S = 300
/** Slow-moving reads. Data readiness re-counts ~14k rows only when rows were inserted (dataReadiness.ts); this
 * bounds it to one re-count per 5 minutes should the memo be cold. */
export const SLOW_TTL_S = 300
/** p4 routes: the roster changes at a monthly cutover; OPB plans, receipts and the LinUCB ledger once a trading day
 * each; kv-config-drift runs once a day (06:00 TW). Paper NAV and failure classes stay at 300 s (orders and tickets
 * are written as they happen). */
export const ROSTER_TTL_S = 3600
export const OPB_TTL_S = 900
export const KV_DRIFT_TTL_S = 1800

type Query = URLSearchParams
type Route = {
  ttl: number
  params: string[]
  /** Dashboard page (dashboard_design.md) and the indicative /monitoring/... name it replaces. */
  page: string
  run: (env: MonitoringEnv, nowMs: number, query: Query) => Promise<Record<string, unknown>>
}

class BadRequest extends Error {}

function dateParam(query: Query): string | null {
  const value = query.get('date')
  if (value == null || value === '') return null
  if (!isIsoDate(value)) throw new BadRequest('date must be YYYY-MM-DD')
  return value
}

/** `chain`: one of CHAIN_IDS, default daily_readiness; /v1/chain/alerts also takes `all`, its default. */
function chainParam(query: Query): ChainId | null
function chainParam(query: Query, allowAll: true): ChainId | 'all' | null
function chainParam(query: Query, allowAll = false): ChainId | 'all' | null {
  const value = query.get('chain')
  if (value == null || value === '') return null
  if (isChainId(value) || (allowAll && value === 'all')) return value
  throw new BadRequest(`chain must be one of ${[...CHAIN_IDS, ...(allowAll ? ['all'] : [])].join(', ')}`)
}

/** `days`: 1-14, default 14. */
function daysParam(query: Query): number {
  const raw = query.get('days')
  if (raw != null && raw !== '' && !/^\d{1,2}$/.test(raw)) throw new BadRequest('days must be 1-14')
  return raw ? Number(raw) : 14
}

/** `days` for the longer windows: 1-max, default `fallback`. */
function daysUpTo(query: Query, max: number, fallback: number): number {
  const raw = query.get('days')
  if (raw == null || raw === '') return fallback
  const value = /^\d{1,3}$/.test(raw) ? Number(raw) : 0
  if (value < 1 || value > max) throw new BadRequest(`days must be 1-${max}`)
  return value
}

/** Every `*_at` value through isoStamp: the p4 sources store `YYYY-MM-DD HH:MM:SS`, microseconds and `+08:00`. */
function withIsoStampsDeep(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => withIsoStampsDeep(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withIsoStampsDeep(v, k)]))
  return key.endsWith('_at') ? isoStamp(value) : value
}

/** p4_sources.md items 1, 2A, 4, 5 and the KV drift part of 6 (monitoringP4Endpoints.test.ts). */
const P4_SOURCES: Record<string, Route> = {
  '/v1/paper/nav': {
    ttl: SLOW_TTL_S, params: ['days'], page: '⑤ Paper NAV vs 加權指數、回撤、持倉、今日下單',
    run: (env, nowMs, query) => paperNavReport(env, nowMs, daysUpTo(query, 365, 60)),
  },
  '/v1/models/roster': { ttl: ROSTER_TTL_S, params: [], page: '⑤ 模型 roster、門檻、月訓結果、下次月訓日', run: (env, nowMs) => modelRosterReport(env, nowMs) },
  '/v1/opb': {
    ttl: OPB_TTL_S, params: ['days'], page: '⑤ OPB arm 佔比、reward 入帳、clip 率、LinUCB ledger',
    run: (env, nowMs, query) => opbReport(env, nowMs, daysUpTo(query, 60, 30)),
  },
  '/v1/chain/failure-classes': {
    ttl: TIMELINE_TTL_S, params: ['days'], page: '③ 14 天失敗分類（scheduler tickets）',
    run: (env, nowMs, query) => failureClassesReport(env, nowMs, daysUpTo(query, 14, 14)),
  },
  '/v1/kv-drift': { ttl: KV_DRIFT_TTL_S, params: [], page: '⑥ KV config drift', run: (env, nowMs) => kvDriftReport(env, nowMs) },
}
export const P4_ROUTES: Record<string, Route> = Object.fromEntries(Object.entries(P4_SOURCES).map(([path, route]) =>
  [path, { ...route, run: async (env, nowMs, query) => withIsoStampsDeep(await route.run(env, nowMs, query)) as Record<string, unknown> }]))

export const ROUTES: Record<string, Route> = {
  '/v1/trading-day': {
    ttl: STATE_TTL_S, params: ['date'], page: '① ② ④ (holiday gating)',
    run: async (env, nowMs, query) => {
      const date = dateParam(query) ?? twDate(nowMs)
      const trading = await isTradingDay(env, date)
      return { date, trading, rows: [{ date, trading }] }
    },
  },
  '/v1/chain/state': {
    ttl: STATE_TTL_S, params: ['chain', 'date'], page: '② 流程鏈（含 FinLab／Pipeline 子階段）、預估收尾與鏈耗時 (/monitoring/chain)',
    run: (env, nowMs, query) => chainStateReport(env, nowMs, dateParam(query), chainParam(query) ?? undefined),
  },
  '/v1/chain/alerts': {
    ttl: STATE_TTL_S, params: ['chain', 'date'], page: '① 今天要我處理什麼, ② alerts (/monitoring/action-items)',
    run: (env, nowMs, query) => chainAlertsReport(env, nowMs, dateParam(query), chainParam(query, true) ?? 'all'),
  },
  '/v1/chain/timeline': {
    ttl: TIMELINE_TTL_S, params: ['chain', 'date', 'days'], page: '② swimlane, ③ 失敗與重複失敗 (/monitoring/failures)',
    run: (env, nowMs, query) => chainTimelineReport(env, nowMs, daysParam(query), dateParam(query), chainParam(query) ?? undefined),
  },
  '/v1/chain/history': {
    ttl: TIMELINE_TTL_S, params: ['chain', 'date', 'days'], page: '③ 每個 task 近 14 天最終結果、重複失敗 (/monitoring/failures)',
    run: (env, nowMs, query) => chainHistoryReport(env, nowMs, daysParam(query), dateParam(query), chainParam(query) ?? undefined),
  },
  '/v1/data-readiness': { ttl: SLOW_TTL_S, params: ['date'], page: '④ 資料就緒 (/monitoring/data-readiness)', run: (env, nowMs, query) => dataReadinessReport(env, nowMs, dateParam(query)) },
  '/v1/capacity': { ttl: SLOW_TTL_S, params: [], page: '⑥ 成本、用量 (DB capacity)', run: (env, nowMs) => capacityReport(env, nowMs) },
  '/v1/evidence-clocks': { ttl: SLOW_TTL_S, params: [], page: '⑤ 模型、決策與 Paper (evidence clocks)', run: (env, nowMs) => evidenceClocksReport(env, nowMs) },
  ...P4_ROUTES,
}

export type MonitoringDeps = {
  now: () => number
  fetch: typeof fetch
  /** Route cache (Cache API or kvCache); null disables caching. */
  cache: Pick<Cache, 'match' | 'put'> | null
  onQuery?: (query: ExecutedQuery) => void
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
  })
}

/** Cache key: the route and its known parameters only (sorted); never headers, never unknown parameters. */
function cacheKey(url: URL, route: Route): Request {
  const params = new URLSearchParams()
  for (const name of [...route.params].sort()) {
    const value = url.searchParams.get(name)
    if (value != null && value !== '') params.set(name, value)
  }
  const search = params.toString()
  return new Request(`${url.origin}${url.pathname}${search ? `?${search}` : ''}`, { method: 'GET' })
}

/** Memo entries live under a path that is not a route, so no request is ever answered from one. */
function cacheMemo(cache: Pick<Cache, 'match' | 'put'>, origin: string): Memo {
  const entry = (key: string) => new Request(`${origin}/__memo/${encodeURIComponent(key)}`, { method: 'GET' })
  return {
    get: async <T>(key: string) => {
      const hit = await cache.match(entry(key))
      return hit ? await hit.json() as T : null
    },
    put: (key, value, ttlS) => cache.put(entry(key), new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `max-age=${ttlS}` },
    })),
  }
}

function served(response: Response, cache: 'HIT' | 'MISS'): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'private, no-store')
  headers.set('x-monitoring-cache', cache)
  return new Response(response.body, { status: response.status, headers })
}

export function createMonitoringHandler(deps: MonitoringDeps) {
  return async function handle(request: Request, env: MonitoringEnv, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' })
    const nowMs = deps.now()
    const denied = await authorize(request, env, deps.fetch, nowMs)
    if (denied) return json(denied.status, { error: denied.error })

    const url = new URL(request.url)
    const route = ROUTES[url.pathname]
    if (!route) return json(404, { error: 'not_found', routes: Object.keys(ROUTES) })
    const key = cacheKey(url, route)
    if (deps.cache) {
      const hit = await deps.cache.match(key)
      if (hit) return served(hit, 'HIT')
    }
    const ledger = new ReadLedger(deps.onQuery)
    let body: Record<string, unknown>
    try {
      const memo = deps.cache ? cacheMemo(deps.cache, url.origin) : undefined
      body = await route.run({ ...readOnlyEnv(env, ledger), MEMO: memo }, nowMs, url.searchParams)
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: 'bad_request', detail: error.message })
      console.error(`[monitoring] ${url.pathname} failed:`, error)
      return json(500, { error: 'internal_error', rows_read: ledger.rowsRead })
    }
    const response = json(200, {
      generated_at: new Date(nowMs).toISOString(), rows_read: ledger.rowsRead, queries: ledger.queries.length,
      cache_ttl_s: route.ttl, ...body,
    }, { 'cache-control': `max-age=${route.ttl}` })
    if (deps.cache) {
      const stored = deps.cache.put(key, response.clone())
      if (ctx) ctx.waitUntil(stored)
      else await stored
    }
    return served(response, 'MISS')
  }
}

/** Per isolate: kvCache's memory layer outlives a request. */
const isolateMemory: Parameters<typeof kvCache>[2] = new Map()

export default {
  fetch(request: Request, env: MonitoringEnv, ctx: ExecutionContext): Promise<Response> {
    const cache = env.MONITORING_CACHE ? kvCache(env.MONITORING_CACHE, Date.now, isolateMemory)
      : typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null
    return createMonitoringHandler({ now: Date.now, fetch: (input, init) => fetch(input, init), cache })(request, env, ctx)
  },
}
