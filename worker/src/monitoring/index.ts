/** stockvision-monitoring: read-only JSON for Grafana (Infinity datasource).
 * GET only (405) → Cloudflare Access JWT (403) → Bearer (401) → route → Cache API (state 30 s, timeline and slow reads 300 s).
 * Every response carries generated_at and rows_read (sum of D1 meta.rows_read of the reads behind it). */
import { authorize } from './auth'
import { capacityReport } from './capacity'
import { chainAlertsReport, chainStateReport, chainTimelineReport } from './chain'
import { dataReadinessReport } from './dataReadiness'
import { readOnlyEnv, isIsoDate, twDate, type Memo, type MonitoringEnv } from './env'
import { evidenceClocksReport } from './evidenceClocks'
import { ReadLedger, type ExecutedQuery } from './readOnlyD1'
import { isTradingDay } from './tradingDay'

/** D11: state-type 30 s, timeline-type 300 s. */
export const STATE_TTL_S = 30
export const TIMELINE_TTL_S = 300
/** Slow-moving reads. Data readiness re-counts ~14k rows only when rows were inserted (dataReadiness.ts); this
 * bounds it to one re-count per 5 minutes should the memo be cold. */
export const SLOW_TTL_S = 300

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

export const ROUTES: Record<string, Route> = {
  '/v1/trading-day': {
    ttl: STATE_TTL_S, params: ['date'], page: '① ② ④ (holiday gating)',
    run: async (env, nowMs, query) => {
      const date = dateParam(query) ?? twDate(nowMs)
      const trading = await isTradingDay(env, date)
      return { date, trading, rows: [{ date, trading }] }
    },
  },
  '/v1/chain/state': { ttl: STATE_TTL_S, params: ['date'], page: '② 流程鏈 (/monitoring/chain)', run: (env, nowMs, query) => chainStateReport(env, nowMs, dateParam(query)) },
  '/v1/chain/alerts': { ttl: STATE_TTL_S, params: ['date'], page: '① 今天要我處理什麼, ② alerts (/monitoring/action-items)', run: (env, nowMs, query) => chainAlertsReport(env, nowMs, dateParam(query)) },
  '/v1/chain/timeline': {
    ttl: TIMELINE_TTL_S, params: ['date', 'days'], page: '② swimlane, ③ 失敗與重複失敗 (/monitoring/failures)',
    run: (env, nowMs, query) => {
      const raw = query.get('days')
      if (raw != null && raw !== '' && !/^\d{1,2}$/.test(raw)) throw new BadRequest('days must be 1-14')
      return chainTimelineReport(env, nowMs, raw ? Number(raw) : 14, dateParam(query))
    },
  },
  '/v1/data-readiness': { ttl: SLOW_TTL_S, params: ['date'], page: '④ 資料就緒 (/monitoring/data-readiness)', run: (env, nowMs, query) => dataReadinessReport(env, nowMs, dateParam(query)) },
  '/v1/capacity': { ttl: SLOW_TTL_S, params: [], page: '⑥ 成本、用量 (DB capacity)', run: (env, nowMs) => capacityReport(env, nowMs) },
  '/v1/evidence-clocks': { ttl: SLOW_TTL_S, params: [], page: '⑤ 模型、決策與 Paper (evidence clocks)', run: (env, nowMs) => evidenceClocksReport(env, nowMs) },
}

export type MonitoringDeps = {
  now: () => number
  fetch: typeof fetch
  /** Cache API cache; null disables caching. */
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

export default {
  fetch(request: Request, env: MonitoringEnv, ctx: ExecutionContext): Promise<Response> {
    const cache = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null
    return createMonitoringHandler({ now: Date.now, fetch: (input, init) => fetch(input, init), cache })(request, env, ctx)
  },
}
