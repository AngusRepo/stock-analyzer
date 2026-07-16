import type { Context, Next } from 'hono'
import type { Bindings, Variables } from '../types'
import {
  authMiddleware,
  requireAdminOrServiceToken,
  requireServiceToken,
} from './auth'

export type RouteAccessPolicy = 'public' | 'authenticated' | 'admin_or_service' | 'service' | 'deny'

const PUBLIC_ROOTS = new Set(['health', 'stocks', 'market', 'news', 'system'])
const AUTHENTICATED_ROOTS = new Set([
  'alerts',
  'backtest',
  'chat',
  'cron',
  'dashboard',
  'datasets',
  'llm',
  'ml',
  'model-pool',
  'notifications',
  'observability',
  'paper',
  'recommendations',
  'scheduler',
  'watchlist',
])
const ADMIN_ROOTS = new Set(['dashboard-state', 'full-analysis', 'runs'])

function apiRoot(path: string): string {
  return path.replace(/^\/api\/?/, '').split('/', 1)[0] ?? ''
}

export function resolveRouteAccessPolicy(path: string, method = 'GET'): RouteAccessPolicy {
  path = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (!path.startsWith('/api/')) return 'deny'
  const verb = method.toUpperCase()
  if (path === '/api/health') return 'public'
  if (path === '/api/auth/google' || path === '/api/auth/callback' || path === '/api/auth/exchange') {
    return 'public'
  }
  if (path.startsWith('/api/auth/admin/')) return 'admin_or_service'
  if (path === '/api/auth/me' || path === '/api/auth/csrf' || path === '/api/auth/logout') return 'authenticated'
  if (path.startsWith('/api/internal/')) return 'service'
  if (path.startsWith('/api/admin/')) return 'admin_or_service'

  if (verb === 'POST' && /^\/api\/news\/[^/]+\/crawl$/.test(path)) return 'authenticated'
  if (
    (verb === 'POST' && path === '/api/stocks') ||
    (verb === 'DELETE' && /^\/api\/stocks\/[^/]+$/.test(path)) ||
    (verb === 'POST' && /^\/api\/stocks\/[^/]+\/refresh$/.test(path))
  ) return 'admin_or_service'

  const root = apiRoot(path)
  if (PUBLIC_ROOTS.has(root)) return verb === 'GET' ? 'public' : 'deny'
  if (AUTHENTICATED_ROOTS.has(root)) return 'authenticated'
  if (ADMIN_ROOTS.has(root)) return 'admin_or_service'
  return 'deny'
}

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>

export async function routePolicyMiddleware(c: AppContext, next: Next): Promise<Response | void> {
  if (c.req.method === 'OPTIONS') {
    await next()
    return
  }

  const policy = resolveRouteAccessPolicy(c.req.path, c.req.method)
  if (policy === 'public') {
    await next()
    return
  }
  if (policy === 'service') {
    const denied = await requireServiceToken(c)
    if (denied) return denied
    await next()
    return
  }
  if (policy === 'admin_or_service') {
    const denied = await requireAdminOrServiceToken(c)
    if (denied) return denied
    await next()
    return
  }
  if (policy === 'authenticated') {
    return authMiddleware(c, next)
  }
  return c.json({
    ok: false,
    error: {
      code: 'route_policy_not_registered',
      message: 'API route is not registered in the access policy',
    },
  }, 403)
}

export const ROUTE_POLICY_ROOTS = {
  public: [...PUBLIC_ROOTS],
  authenticated: [...AUTHENTICATED_ROOTS],
  admin: [...ADMIN_ROOTS],
} as const
