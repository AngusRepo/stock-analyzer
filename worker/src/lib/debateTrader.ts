/**
 * debateTrader.ts — Bull/Bear 多空辯論 for Paper Trading
 *
 * 3 rounds: Bull(ML reasoning) → Bear(challenge) → Judge(verdict)
 * MAX 3 rounds hardcoded to control token cost
 *
 * LLM 三層 fallback（成本最低優先）：
 *   1. 本地 Tunnel → Claude Opus（Max Plan 已付費，透過 Cloudflare Tunnel 呼叫）
 *   2. Workers AI  → Llama 3.3 70B（$5 plan 包含，免費）
 *   3. Anthropic API → Claude Haiku（花錢，最後手段）
 *
 * Verdict: APPROVE → normal buy / DOWNGRADE → halve position / REJECT → skip
 */

export type DebateVerdict = 'APPROVE' | 'DOWNGRADE' | 'REJECT'

export interface DebateResult {
  verdict: DebateVerdict
  rounds: number
  summary: string  // stored in paper_orders.note
  llmSource: string // 'tunnel' | 'workers_ai' | 'anthropic_api'
}

export interface StockProfile {
  business_desc?: string | null
  key_customers?: string | null
  key_suppliers?: string | null
}

interface LLMEnv {
  LOCAL_TUNNEL_URL?: string   // e.g. https://claude-proxy.your-tunnel.cfargotunnel.com
  AI?: any                    // Cloudflare Workers AI binding
  ANTHROPIC_API_KEY?: string  // Anthropic API key (last resort)
  KV?: KVNamespace            // 讀 ml:config.debate_model（可 runtime 換模型）
}

// KV 型別（簡化，與 Cloudflare 相容）
declare const KVNamespace: any
type KVNamespace = { get(k: string, t?: string): Promise<any>; put(k: string, v: string): Promise<void> }

// in-memory cache for ml:config（5 min，避免每次 debate 都讀 KV）
let _mlConfigCached: Record<string, any> | null = null
let _mlConfigCachedAt = 0
const ML_CONFIG_TTL = 5 * 60_000

async function getMlConfig(kv: KVNamespace): Promise<Record<string, any>> {
  if (_mlConfigCached && Date.now() - _mlConfigCachedAt < ML_CONFIG_TTL) return _mlConfigCached
  try {
    const raw = await kv.get('ml:config', 'json') as Record<string, any> | null
    _mlConfigCached = raw ?? {}
  } catch {
    _mlConfigCached = {}
  }
  _mlConfigCachedAt = Date.now()
  return _mlConfigCached
}

// ─── 三層 LLM Fallback ──────────────────────────────────────────────────────

/**
 * 依優先順序嘗試呼叫 LLM：
 *   1. 本地 Tunnel (Claude Opus) — 最強品質，Max Plan 免費
 *   2. Workers AI (Llama 3.3 70B) — $5 plan 包含
 *   3. Anthropic API (Haiku) — 花錢，最後手段
 */
async function callLLM(
  env: LLMEnv,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; source: string }> {

  // ── Layer 1: 本地 Tunnel (Claude Opus) ──────────────────────────────────
  // Opus 品質的辯論才有意義；8B 等弱模型辯論品質不足，不如不跑
  if (env.LOCAL_TUNNEL_URL) {
    try {
      const health = await fetch(`${env.LOCAL_TUNNEL_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (health.ok) {
        const res = await fetch(`${env.LOCAL_TUNNEL_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: systemPrompt, user: userPrompt, max_tokens: 512 }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const json = await res.json() as any
          const text = json?.text ?? json?.content ?? json?.response ?? ''
          if (text) return { text, source: 'tunnel' }
        }
      }
    } catch {
      // Tunnel 不通 → 跳過辯論
    }
  }

  // ── Layer 2: Workers AI (Llama 3.3 70B) — Max Plan 免費 ─────────────────
  if (env.AI) {
    try {
      const result = await (env.AI as any).run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 512,
      }) as any
      const text = result?.response ?? ''
      if (text) return { text, source: 'workers_ai' }
    } catch (e) {
      console.warn('[Debate] Workers AI failed:', e)
    }
  }

  // ── Layer 3: Anthropic API (Haiku) — 最後手段 ───────────────────────────
  if (env.ANTHROPIC_API_KEY) {
    try {
      // 模型名稱從 KV ml:config.debate_model 讀取，允許 runtime 升級
      const debateModel = env.KV
        ? (await getMlConfig(env.KV)).debate_model ?? 'claude-haiku-4-5-20251001'
        : 'claude-haiku-4-5-20251001'
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: debateModel,
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      })
      if (res.ok) {
        const json = await res.json() as any
        const text = json?.content?.[0]?.text ?? ''
        if (text) return { text, source: 'anthropic_api' }
      }
    } catch (e) {
      console.warn('[Debate] Anthropic API failed:', e)
    }
  }

  throw new Error('All LLM layers unavailable — debate skipped')
}

// ─── Main Debate Function ─────────────────────────────────────────────────────

// ─── Helper: 從 JSON 字串解析陣列並取前 N 項合併為字串 ─────────────────────
function parseJsonArray(raw: string | null | undefined, maxItems = 3): string {
  if (!raw) return ''
  try {
    const arr = JSON.parse(raw) as string[]
    return arr.slice(0, maxItems).join('；')
  } catch {
    return raw.slice(0, 200)
  }
}

export async function runBuyDebate(
  symbol: string,
  stockName: string,
  signal: string,
  confidence: number,
  reasoning: string,
  env: LLMEnv,
  usContext?: string,
  stockProfile?: StockProfile,
): Promise<DebateResult> {
  // ── Round 1 (Bull): Format ML ensemble reasoning as the bull case ─────────
  const profileLines: string[] = []
  if (stockProfile) {
    if (stockProfile.business_desc) {
      // 取前 250 字，去除 markdown 加粗符號
      const desc = stockProfile.business_desc.replace(/\*\*/g, '').slice(0, 250)
      profileLines.push(`【公司概況】${desc}`)
    }
    const customers = parseJsonArray(stockProfile.key_customers, 3)
    if (customers) profileLines.push(`【主要客戶】${customers.replace(/\*\*/g, '').slice(0, 150)}`)
    const suppliers = parseJsonArray(stockProfile.key_suppliers, 3)
    if (suppliers) profileLines.push(`【主要供應商】${suppliers.replace(/\*\*/g, '').slice(0, 150)}`)
  }

  const bullCase = [
    `Stock: ${symbol} (${stockName})`,
    `Signal: ${signal} | Confidence: ${(confidence * 100).toFixed(1)}%`,
    ...(usContext ? [`【美股前夜】${usContext}`] : []),
    ...profileLines,
    `ML Ensemble Reasoning:`,
    reasoning,
  ].join('\n')

  // ── Round 2 (Bear): Challenge the bull case ──────────────────────────────
  const bearSystemPrompt = [
    'You are a skeptical risk analyst. Your job is to challenge a BUY recommendation.',
    'Provide 3-5 concrete risk challenges from these angles:',
    '1. Model blindness — what data the ML model cannot see',
    '2. Technical reversal — chart patterns suggesting exhaustion or reversal',
    '3. Stop-loss risk — potential downside beyond normal volatility',
    '4. Black swan — macro/sector/geopolitical tail risks',
    '5. Timing — why entering NOW may be premature',
    'Be concise. No pleasantries. Max 300 words. Reply in Traditional Chinese.',
  ].join('\n')

  let bearCase = ''
  let llmSource = 'unknown'
  try {
    const bearResult = await callLLM(env, bearSystemPrompt, `Challenge this BUY case:\n\n${bullCase}`)
    bearCase = bearResult.text
    llmSource = bearResult.source
  } catch (e) {
    console.warn(`[Debate] Bear round failed for ${symbol}: ${e}`)
    return { verdict: 'APPROVE', rounds: 1, summary: `Bull only (LLM error): ${bullCase}`.slice(0, 500), llmSource: 'none' }
  }

  // ── Round 3 (Judge): Evaluate both cases and decide ──────────────────────
  const judgeSystemPrompt = [
    'You are an impartial trading judge. Review the Bull and Bear cases below.',
    'Output exactly ONE of these verdicts on the FIRST line:',
    'APPROVE — strong consensus, risks are manageable, proceed with full position',
    'DOWNGRADE — valid concerns identified, reduce exposure by 50%',
    'REJECT — critical risks identified, skip this trade entirely',
    '',
    'After the verdict line, write a 1-2 sentence rationale in Traditional Chinese. Nothing else.',
  ].join('\n')

  const judgeUserPrompt = [
    '=== BULL CASE ===',
    bullCase,
    '',
    '=== BEAR CASE ===',
    bearCase,
    '',
    'Your verdict (APPROVE / DOWNGRADE / REJECT):',
  ].join('\n')

  let judgeResponse = ''
  try {
    const judgeResult = await callLLM(env, judgeSystemPrompt, judgeUserPrompt)
    judgeResponse = judgeResult.text
    // 以 judge 的 source 為準（兩 round 可能用不同 layer）
    llmSource = judgeResult.source
  } catch (e) {
    console.warn(`[Debate] Judge round failed for ${symbol}: ${e}`)
    return {
      verdict: 'APPROVE', rounds: 2,
      summary: `Bull+Bear done (Judge error). Bull: ${bullCase.slice(0, 200)} | Bear: ${bearCase.slice(0, 200)}`.slice(0, 500),
      llmSource,
    }
  }

  const verdict = parseVerdict(judgeResponse)

  const summary = [
    `[${verdict}|${llmSource}] `,
    `Bull: ${signal} conf=${(confidence * 100).toFixed(0)}% | `,
    `Bear: ${bearCase.slice(0, 150)} | `,
    `Judge: ${judgeResponse.slice(0, 150)}`,
  ].join('').slice(0, 500)

  return { verdict, rounds: 3, summary, llmSource }
}

// ─── Verdict Parser ───────────────────────────────────────────────────────────

function parseVerdict(response: string): DebateVerdict {
  const upper = response.toUpperCase()
  const firstLine = upper.split('\n')[0] ?? ''

  if (firstLine.includes('REJECT'))    return 'REJECT'
  if (firstLine.includes('DOWNGRADE')) return 'DOWNGRADE'
  if (firstLine.includes('APPROVE'))   return 'APPROVE'

  if (upper.includes('REJECT'))    return 'REJECT'
  if (upper.includes('DOWNGRADE')) return 'DOWNGRADE'

  // Default: don't block trades on parse error
  return 'APPROVE'
}
