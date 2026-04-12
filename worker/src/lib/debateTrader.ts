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

// ─── P1#14: Prompt Injection Detection ────────────────────────────────────────
const DANGER_PATTERNS: Array<[RegExp, string, string]> = [
  [/ignore\s+(all\s+)?(previous|above|prior)\s+(instruction|prompt|rule)/i, 'critical', 'instruction_override'],
  [/disregard\s+(everything|all|the)\s+(above|previous)/i, 'critical', 'instruction_override'],
  [/forget\s+(your|all|previous)\s+(instruction|rule|prompt)/i, 'critical', 'instruction_override'],
  [/you\s+are\s+now\s+a/i, 'critical', 'role_hijack'],
  [/\b(all[\s-]?in|go\s+all\s+in)\b/i, 'high', 'extreme_action'],
  [/\b(sell\s+everything|liquidate\s+all|dump\s+all)\b/i, 'high', 'extreme_action'],
  [/\b(buy\s+maximum|max\s+position|maximum\s+leverage)\b/i, 'high', 'extreme_action'],
  [/\b(guaranteed|risk[\s-]?free|cannot\s+lose|sure\s+thing)\b/i, 'medium', 'unrealistic_claim'],
  [/\b(insider\s+(info|tip|knowledge)|confidential\s+(info|source)|secret\s+info|tip\s+from\s+(a|an|my)\s+(friend|source))\b/i, 'high', 'insider_claim'],
  [/\b(act\s+now|immediately|urgent|don'?t\s+wait|must\s+buy\s+today)\b/i, 'medium', 'urgency_manipulation'],
]

function checkInjection(rawText: string): { action: string; severity: string; matches: Array<{pattern: string; severity: string}> } {
  // VULN-31 fix: strip zero-width Unicode characters before matching
  const text = rawText.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
  const matches: Array<{pattern: string; severity: string}> = []
  for (const [regex, severity, desc] of DANGER_PATTERNS) {
    if (regex.test(text)) matches.push({ pattern: desc, severity })
  }
  if (matches.length === 0) return { action: 'pass', severity: 'none', matches: [] }
  const hasCritical = matches.some(m => m.severity === 'critical')
  const hasHigh = matches.some(m => m.severity === 'high')
  return {
    action: hasCritical ? 'reject' : hasHigh ? 'downgrade' : 'downgrade',
    severity: hasCritical ? 'critical' : hasHigh ? 'high' : 'medium',
    matches,
  }
}

export type DebateVerdict = 'APPROVE' | 'DOWNGRADE' | 'REJECT'

export interface DebateResult {
  verdict: DebateVerdict
  rounds: number
  summary: string  // stored in paper_orders.note
  llmSource: string // 'tunnel' | 'workers_ai' | 'anthropic_api'
  convictionScore: number // 0-100, judge 的信念度評分
}

export interface StockProfile {
  business_desc?: string | null
  key_customers?: string | null
  key_suppliers?: string | null
}

interface LLMEnv {
  LOCAL_TUNNEL_URL?: string   // e.g. https://claude-proxy.your-tunnel.cfargotunnel.com
  AI?: any                    // Cloudflare Workers AI binding
  GEMINI_API_KEY?: string     // Gemini 3.1 Flash Lite (primary cheap+fast)
  ANTHROPIC_API_KEY?: string  // Anthropic API key (last resort fallback)
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
  temperature: number = 0.4,
): Promise<{ text: string; source: string }> {

  // ── Layer 1: 本地 Tunnel (Claude Opus) ──────────────────────────────────
  if (env.LOCAL_TUNNEL_URL) {
    try {
      const health = await fetch(`${env.LOCAL_TUNNEL_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (health.ok) {
        const res = await fetch(`${env.LOCAL_TUNNEL_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: systemPrompt, user: userPrompt, max_tokens: 512, temperature }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const json = await res.json() as any
          const text = json?.text ?? json?.content ?? json?.response ?? ''
          if (text) return { text, source: 'tunnel' }
        }
      }
    } catch {
      // Tunnel 不通 → 下一層
    }
  }

  // ── Layer 2: Gemini 3.1 Flash Lite — 主力（便宜+快速+中文好）──────────
  if (env.GEMINI_API_KEY) {
    try {
      const geminiModel = 'gemini-3.1-flash-lite-preview'
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature, maxOutputTokens: 512 },
          }),
        }
      )
      if (res.ok) {
        const json = await res.json() as any
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        if (text) return { text, source: 'gemini_api' }
      }
    } catch (e) {
      console.warn('[Debate] Gemini API failed:', e)
    }
  }

  // ── Layer 3: Anthropic API (Haiku) — 最後手段 fallback ─────────────────
  if (env.ANTHROPIC_API_KEY) {
    try {
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
          temperature,
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
  taifexContext?: string,
): Promise<DebateResult> {
  // ── Context: 組裝 ML data + stock profile 作為共用 input ──────────────────
  const profileLines: string[] = []
  if (stockProfile) {
    if (stockProfile.business_desc) {
      const desc = stockProfile.business_desc.replace(/\*\*/g, '').slice(0, 250)
      profileLines.push(`【公司概況】${desc}`)
    }
    const customers = parseJsonArray(stockProfile.key_customers, 3)
    if (customers) profileLines.push(`【主要客戶】${customers.replace(/\*\*/g, '').slice(0, 150)}`)
    const suppliers = parseJsonArray(stockProfile.key_suppliers, 3)
    if (suppliers) profileLines.push(`【主要供應商】${suppliers.replace(/\*\*/g, '').slice(0, 150)}`)
  }

  const mlContext = [
    `Stock: ${symbol} (${stockName})`,
    `Signal: ${signal} | Confidence: ${(confidence * 100).toFixed(1)}%`,
    ...(usContext ? [`【美股前夜】${usContext}`] : []),
    ...(taifexContext ? [`【台指期夜盤】${taifexContext}`] : []),
    ...profileLines,
    `ML Ensemble Reasoning:`,
    reasoning,
  ].join('\n')

  // ── Round 1 (Zealot): 極度看多 — LLM rewrite ML data 為敘事體 ──────────
  // Apex Quant 設計：Zealot 跟 Reaper 都用 LLM 生成散文，消除 narrative bias
  const zealotSystemPrompt = [
    '你是 Zealot — 一位極度樂觀的多頭交易員。',
    '你的信念：每一支被 ML 模型選中的股票都有獨到的買入理由。',
    '你的任務：根據以下 ML 數據和公司資訊，寫出 3-5 個強力看多理由。',
    '',
    '規則：',
    '- 不准說「但是」「不過」「風險」「需要注意」，你是死多頭',
    '- 把 ML 信號、技術面、籌碼面的正面訊號放大解讀',
    '- 簡潔有力，最多 300 字。用繁體中文回答。',
  ].join('\n')

  let zealotCase = ''
  let llmSource = 'unknown'
  try {
    const zealotResult = await callLLM(env, zealotSystemPrompt, `Write the bull case:\n\n${mlContext}`, 0.5)
    zealotCase = zealotResult.text
    llmSource = zealotResult.source
    console.log(`[Debate] Zealot done for ${symbol} via ${zealotResult.source}`)
  } catch (e) {
    console.warn(`[Debate] Zealot round failed for ${symbol}: ${e}`)
    // Fallback: 用原始 ML data 作為 zealot case（降級但不放棄）
    zealotCase = mlContext
  }

  // ── Round 2 (Reaper): 極度看空 — 找致命缺陷 ────────────────────────────
  const reaperSystemPrompt = [
    '你是 Reaper — 一位極度悲觀的空頭風控分析師（融合 Charlie Munger + Michael Burry）。',
    '你的信念：任何看起來完美的交易都藏著致命缺陷。',
    '你的任務：從以下角度挑戰這個 BUY 推薦，找出多頭忽略的風險：',
    '',
    '【價值面】估值合理性、護城河是否真實',
    '【動能面】技術疲態、追高風險、量價背離',
    '【宏觀面】總經/地緣尾部風險',
    '',
    '規則：',
    '- 不准說「優點是」「看好」「值得買入」，你是死空頭',
    '- 每個挑戰都要具體，不要空泛警告',
    '- 提出 3-5 個致命挑戰。最多 300 字。用繁體中文回答。',
  ].join('\n')

  let reaperCase = ''
  try {
    const reaperResult = await callLLM(env, reaperSystemPrompt, `Challenge this BUY case:\n\n${mlContext}`, 0.7)
    reaperCase = reaperResult.text
    llmSource = reaperResult.source
    console.log(`[Debate] Reaper done for ${symbol} via ${reaperResult.source}`)
  } catch (e) {
    console.warn(`[Debate] Reaper round failed for ${symbol}: ${e}`)
    return { verdict: 'APPROVE', rounds: 1, summary: `Zealot only (Reaper LLM error): ${zealotCase}`.slice(0, 500), llmSource, convictionScore: 60 }
  }

  // ── Round 3 (Fulcrum): 冷靜裁決 — 低 temperature 穩定判決 ──────────────
  const fulcrumSystemPrompt = [
    '你是 Fulcrum — 一位冷靜公正的交易裁決者。你只看證據，不被情緒左右。',
    '',
    '第一行輸出格式（嚴格遵守）：',
    'VERDICT: <APPROVE|DOWNGRADE|REJECT> CONVICTION: <0-100>',
    '',
    '判決標準：',
    'APPROVE — 風險可控，Zealot 論點有力（conviction >= 70）',
    'DOWNGRADE — 有合理疑慮，減半倉位（conviction 40-69）',
    'REJECT — Reaper 指出的風險無法忽視（conviction < 40）',
    '',
    'conviction score = 你對此交易的信念程度（0=完全不信 100=極度看好）。',
    '',
    '第二行起用繁體中文寫 1-2 句判決理由。不要有其他格式。',
  ].join('\n')

  const fulcrumUserPrompt = [
    '=== ZEALOT CASE (極度看多) ===',
    zealotCase,
    '',
    '=== REAPER CASE (極度看空) ===',
    reaperCase,
    '',
    'Your verdict (APPROVE / DOWNGRADE / REJECT):',
  ].join('\n')

  let fulcrumResponse = ''
  try {
    const fulcrumResult = await callLLM(env, fulcrumSystemPrompt, fulcrumUserPrompt, 0.2)
    fulcrumResponse = fulcrumResult.text
    llmSource = fulcrumResult.source
    console.log(`[Debate] Fulcrum done for ${symbol} via ${fulcrumResult.source}`)
  } catch (e) {
    console.warn(`[Debate] Fulcrum round failed for ${symbol}: ${e}`)
    return {
      verdict: 'APPROVE', rounds: 2,
      summary: `Zealot+Reaper done (Fulcrum error). Zealot: ${zealotCase.slice(0, 200)} | Reaper: ${reaperCase.slice(0, 200)}`.slice(0, 500),
      llmSource, convictionScore: 60,
    }
  }

  // P1#14: Prompt injection detection — scan Reaper + Fulcrum (not Zealot, which is LLM rewrite of ML data)
  const injectionCheck = checkInjection([reaperCase, fulcrumResponse].join('\n'))
  if (injectionCheck.action === 'reject') {
    console.warn(`[Debate] INJECTION DETECTED for ${symbol}: ${injectionCheck.matches.map((m: any) => m.pattern).join(', ')}`)
    return {
      verdict: 'REJECT' as DebateVerdict, rounds: 3,
      summary: `[INJECTION_BLOCKED] ${injectionCheck.matches.map((m: any) => m.pattern).join(', ')}`.slice(0, 500),
      llmSource, convictionScore: 0,
    }
  }

  let verdict = parseVerdict(fulcrumResponse)
  const convictionScore = parseConviction(fulcrumResponse)

  // P1#14: Downgrade if medium/high injection detected
  if (injectionCheck.action === 'downgrade' && verdict === 'APPROVE') {
    console.warn(`[Debate] Injection downgrade for ${symbol}: ${injectionCheck.matches.map((m: any) => m.pattern).join(', ')}`)
    verdict = 'DOWNGRADE'
  }

  const summary = [
    `[${verdict}|conv:${convictionScore}|${llmSource}] `,
    injectionCheck.action !== 'pass' ? `[INJ:${injectionCheck.severity}] ` : '',
    `Reaper: ${reaperCase.slice(0, 120)} | `,
    `Fulcrum: ${fulcrumResponse.replace(/VERDICT:.*\n?/, '').trim().slice(0, 150)}`,
  ].join('').slice(0, 500)

  return { verdict, rounds: 3, summary, llmSource, convictionScore }
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

function parseConviction(response: string): number {
  // 解析 "CONVICTION: 75" 格式
  const match = response.match(/CONVICTION:\s*(\d+)/i)
  if (match) return Math.min(100, Math.max(0, parseInt(match[1])))
  // fallback: 根據 verdict 給預設值
  const v = parseVerdict(response)
  if (v === 'APPROVE') return 75
  if (v === 'DOWNGRADE') return 50
  return 25
}
