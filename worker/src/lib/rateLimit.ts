/**
 * rateLimit.ts — KV-based sliding window rate limiter
 *
 * 保護 LLM 和 ML 端點，防止惡意或意外的大量呼叫耗盡 Anthropic 配額
 *
 * 規則：
 *   - LLM 端點（/ai/*）：每 IP 每分鐘 10 次
 *   - ML 端點（/ml/predict）：每 IP 每分鐘 5 次
 *   - 通用 API：每 IP 每分鐘 60 次
 */

interface KVNamespace {
  get(key: string, type?: string): Promise<any>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export type RateLimitTier = 'llm' | 'ml' | 'api'

// ── 預設值（hardcode fallback）────────────────────────────────────────────────
const DEFAULT_LIMITS: Record<RateLimitTier, { max: number; windowSec: number }> = {
  llm: { max: 10,  windowSec: 60 },
  ml:  { max: 5,   windowSec: 60 },
  api: { max: 60,  windowSec: 60 },
}

// ── system:config KV 快取（5 min，避免每次請求都讀 KV）─────────────────────────
let _sysConfigCached: Record<string, any> | null = null
let _sysConfigCachedAt = 0
const SYS_CONFIG_TTL = 5 * 60_000

async function getRateLimits(kv: KVNamespace): Promise<Record<RateLimitTier, { max: number; windowSec: number }>> {
  if (_sysConfigCached && Date.now() - _sysConfigCachedAt < SYS_CONFIG_TTL) {
    return _buildLimits(_sysConfigCached)
  }
  try {
    const raw = await kv.get('system:config', 'json') as Record<string, any> | null
    _sysConfigCached = raw ?? {}
  } catch {
    _sysConfigCached = {}
  }
  _sysConfigCachedAt = Date.now()
  return _buildLimits(_sysConfigCached)
}

function _buildLimits(cfg: Record<string, any>): Record<RateLimitTier, { max: number; windowSec: number }> {
  const d = DEFAULT_LIMITS
  return {
    llm: { max: cfg.rate_limit_llm  ?? d.llm.max,  windowSec: 60 },
    ml:  { max: cfg.rate_limit_ml   ?? d.ml.max,   windowSec: 60 },
    api: { max: cfg.rate_limit_api  ?? d.api.max,  windowSec: 60 },
  }
}

// 向後相容：同步讀取（KV 未初始化前的 fallback）
const LIMITS = DEFAULT_LIMITS

function clientKey(req: Request): string {
  const cf = (req as any).cf
  const ip = cf?.ip ?? req.headers.get('CF-Connecting-IP') ?? 'unknown'
  return ip
}

export async function checkRateLimit(
  kv: KVNamespace,
  req: Request,
  tier: RateLimitTier,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const limits = await getRateLimits(kv)
  const { max, windowSec } = limits[tier]
  const ip = clientKey(req)
  const now = Math.floor(Date.now() / 1000)
  const window = Math.floor(now / windowSec)
  const key = `rl:${tier}:${ip}:${window}`

  try {
    const raw = await kv.get(key)
    const count = raw ? parseInt(raw, 10) : 0

    if (count >= max) {
      return { allowed: false, remaining: 0, resetIn: windowSec - (now % windowSec) }
    }

    await kv.put(key, String(count + 1), { expirationTtl: windowSec * 2 })
    return { allowed: true, remaining: max - count - 1, resetIn: windowSec - (now % windowSec) }
  } catch {
    // KV 失敗時放行，不影響正常功能
    return { allowed: true, remaining: max, resetIn: windowSec }
  }
}

/** Hono middleware factory */
export function rateLimitMiddleware(tier: RateLimitTier) {
  return async (c: any, next: () => Promise<void>) => {
    const { allowed, remaining, resetIn } = await checkRateLimit(c.env.KV, c.req.raw, tier)

    c.header('X-RateLimit-Limit',     String(DEFAULT_LIMITS[tier].max))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset',     String(resetIn))

    if (!allowed) {
      return c.json(
        { error: '請求過於頻繁，請稍後再試', retry_after: resetIn },
        429,
      )
    }
    return next()
  }
}
