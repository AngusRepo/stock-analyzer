import { readScoreV2Snapshot } from './scoreV2Taxonomy'

/**
 * llm.ts — Anthropic Claude API client
 */

export interface RichContext {
  // 近期新聞（最多 7 筆）
  recentNews?: Array<{ title: string; sentiment: string; publishedAt: string }> | null
  // 大盤風險
  marketRisk?: { riskLevel: string; riskScore: number; riskSummary: string } | null
  // 模型真實準確率
  modelAccuracy?: Array<{ modelName: string; accuracy: number; totalCount: number; period: string }> | null
  // 個股記憶（歷史規律）
  stockMemories?: Array<{ memoryType: string; content: string }> | null
  // 最近 5 次預測結果
  recentPredictions?: Array<{ signal: string; direction_correct: number | null; generatedAt: string }> | null
}

export interface TechnicalSnapshot {
  symbol: string; name: string; currentPrice: number
  ma5?: number | null; ma10?: number | null; ma20?: number | null; ma60?: number | null
  rsi14?: number | null
  macd?: number | null; macdSignal?: number | null; macdHist?: number | null
  bbUpper?: number | null; bbMid?: number | null; bbLower?: number | null
  atr14?: number | null
  compositeScore?: number | null; quantile?: number | null
  zMomentum?: number | null; zValue?: number | null; zQuality?: number | null
  sharpeRatio?: number | null; maxDrawdown?: number | null; beta?: number | null; var95?: number | null
  tradeSignal?: 'buy' | 'sell' | 'hold'
  entryPrice?: number | null; stopLoss?: number | null; target1?: number | null; target2?: number | null
  forecastPrice?: number | null
}

type ClaudeModel = 'haiku' | 'sonnet'
const MODEL_IDS: Record<ClaudeModel, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',  // analyst-summary 用，品質更高
}

async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1024,
  model: ClaudeModel = 'haiku',
  useCache = false,
): Promise<string> {
  // Prompt Caching：system prompt 第一次寫快取，後續讀快取（省 90% input token）
  const systemContent = useCache
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt

  const body = JSON.stringify({
    model: MODEL_IDS[model],
    max_tokens: maxTokens,
    system: systemContent,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const MAX_RETRIES = 3
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...(useCache ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
      },
      body,
    })

    // 429 Rate Limit / 529 Overloaded → 指數退避後重試
    if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
      console.warn(`[LLM] Anthropic ${res.status}, retry ${attempt}/${MAX_RETRIES - 1} in ${attempt * 2}s`)
      await new Promise(r => setTimeout(r, attempt * 2000))
      continue
    }

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Anthropic API error: ${res.status} ${err}`)
    }

    const data = await res.json() as any
    return data.content?.[0]?.text ?? '無法生成分析，請稍後再試。'
  }

  throw new Error('Anthropic API: max retries exceeded')
}

// ─── Technical Analysis ───────────────────────────────────────────────────────
export async function generateTechnicalAnalysis(apiKey: string, snapshot: TechnicalSnapshot, rich?: RichContext): Promise<string> {
  const system = `你是一位專業的台灣股市技術分析師，擅長解讀技術指標並給出清晰的中文分析。
請根據提供的技術指標數據與背景資訊，給出：
1. 技術面現況（2-3句）
2. 主要訊號解讀（條列式，最多4點）
3. 短期展望（1-2句，需考量大盤風險環境）
請使用繁體中文，語氣專業但易懂，避免過度樂觀或悲觀，強調風險。`

  const prompt = buildTechnicalPrompt(snapshot) + buildRichContext(rich)
  try {
    return await callClaude(apiKey, system, prompt)
  } catch (e) {
    console.error('[LLM] Technical analysis failed:', e)
    return 'AI 分析暫時無法使用，請稍後再試。'
  }
}

// ─── Trading Advice ───────────────────────────────────────────────────────────
export async function generateTradingAdvice(apiKey: string, snapshot: TechnicalSnapshot, rich?: RichContext): Promise<string> {
  const system = `你是一位專業的股票交易策略師，擅長根據技術分析給出具體的交易建議。
請根據提供的數據，給出：
1. 操作建議（買進/賣出/觀望）及理由（2-3句）
2. 建議進場價位區間
3. 止損設置建議
4. 目標價位（短期/中期）
5. 風險提示（1-2點）
請使用繁體中文，務必強調投資風險，本分析僅供參考，非投資建議。`

  const prompt = buildTechnicalPrompt(snapshot) + buildRichContext(rich)
  try {
    return await callClaude(apiKey, system, prompt)
  } catch (e) {
    return 'AI 建議暫時無法使用，請稍後再試。'
  }
}

// ─── Analyst Summary ──────────────────────────────────────────────────────────
// analyst-summary 使用 Sonnet + Prompt Cache（品質要求高，適合完整三面向分析）
export async function generateAnalystSummary(apiKey: string, params: {
  snapshot: TechnicalSnapshot
  financials: { revenue?: number | null; revenueGrowth?: number | null; eps?: number | null; pe?: number | null; pb?: number | null; dividendYield?: number | null; roe?: number | null } | null
  chipData: { foreignNetBuy?: number | null; investmentTrustNetBuy?: number | null; dealerNetBuy?: number | null; marginBalance?: number | null } | null
  rich?: RichContext
}): Promise<string> {
  const system = `你是一位資深股票分析師，能夠整合技術面、基本面、籌碼面給出全面的投資分析報告。
請給出一份完整的分析摘要，包含：
1. 整體評分（技術/基本/籌碼各20分，共60分）
2. 技術面分析（2-3句）
3. 基本面分析（2-3句）
4. 籌碼面分析（2-3句，如有資料）
5. 綜合結論與操作建議
請使用繁體中文，本分析僅供參考，非投資建議。`

  const { snapshot, financials, chipData } = params
  let prompt = buildTechnicalPrompt(snapshot)
  if (financials) {
    prompt += `\n\n【基本面】EPS: ${financials.eps ?? 'N/A'} | PE: ${financials.pe ?? 'N/A'} | PB: ${financials.pb ?? 'N/A'} | ROE: ${financials.roe ?? 'N/A'}% | 殖利率: ${financials.dividendYield ?? 'N/A'}% | 營收成長: ${financials.revenueGrowth != null ? (financials.revenueGrowth * 100).toFixed(1) + '%' : 'N/A'}`
  }
  if (chipData) {
    prompt += `\n\n【籌碼面】外資買賣超: ${chipData.foreignNetBuy ?? 'N/A'} 張 | 投信買賣超: ${chipData.investmentTrustNetBuy ?? 'N/A'} 張 | 融資餘額: ${chipData.marginBalance ?? 'N/A'} 張`
  }
  prompt += buildRichContext(params.rich)
  try {
    return await callClaude(apiKey, system, prompt, 1500, 'sonnet', true)
  } catch (e) {
    return 'AI 分析師摘要暫時無法使用，請稍後再試。'
  }
}

// ─── Ask Question (Chatbot) ───────────────────────────────────────────────────
export async function answerStockQuestion(apiKey: string, params: {
  question: string
  snapshot: TechnicalSnapshot
  financials: any
  chipData: any
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
}): Promise<string> {
  const { question, snapshot, financials, chipData, conversationHistory = [] } = params

  const system = `你是一位專業的股票分析助理，能夠回答關於 ${snapshot.symbol}(${snapshot.name}) 的各種問題。
目前股價：${snapshot.currentPrice}，使用繁體中文回答，回答要精簡有重點，並提醒投資風險。`

  let context = buildTechnicalPrompt(snapshot)
  if (financials) context += `\nEPS: ${financials.eps ?? 'N/A'} | PE: ${financials.pe ?? 'N/A'}`
  if (chipData) context += `\n外資: ${chipData.foreignNetBuy ?? 'N/A'}`

  const messages = [
    ...conversationHistory,
    { role: 'user' as const, content: `背景資料：\n${context}\n\n問題：${question}` }
  ]

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL_IDS['sonnet'], max_tokens: 1200, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages }),
    })
    const data = await res.json() as any
    return data.content?.[0]?.text ?? '無法回答，請稍後再試。'
  } catch (e) {
    return '問答功能暫時無法使用，請稍後再試。'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildRichContext(rich?: RichContext): string {
  if (!rich) return ''
  const parts: string[] = []

  if (rich.marketRisk) {
    parts.push(`\n\n【大盤風險環境】風險等級: ${rich.marketRisk.riskLevel}（${rich.marketRisk.riskScore}/100）\n${rich.marketRisk.riskSummary}`)
  }

  if (rich.recentNews?.length) {
    const newsStr = rich.recentNews
      .slice(0, 5)
      .map(n => `・${n.sentiment === 'positive' ? '📈' : n.sentiment === 'negative' ? '📉' : '➖'} ${n.title}`)
      .join('\n')
    parts.push(`\n\n【近期相關新聞】\n${newsStr}`)
  }

  if (rich.modelAccuracy?.length) {
    const accStr = rich.modelAccuracy
      .filter(a => a.totalCount >= 5)
      .map(a => `${a.modelName} ${(a.accuracy * 100).toFixed(0)}%（${a.totalCount}次/${a.period}）`)
      .join('、')
    if (accStr) parts.push(`\n\n【ML模型真實準確率】${accStr}`)
  }

  if (rich.recentPredictions?.length) {
    const verified = rich.recentPredictions.filter(p => p.direction_correct === 0 || p.direction_correct === 1)
    if (verified.length) {
      const correctCount = verified.filter(p => p.direction_correct === 1).length
      parts.push(`\n\n【近期預測戰績】最近 ${verified.length} 次驗證：${correctCount} 次正確（${((correctCount/verified.length)*100).toFixed(0)}%）`)
    }
  }

  if (rich.stockMemories?.length) {
    const memories = rich.stockMemories.map(m => m.content).join('\n')
    parts.push(`\n\n【個股歷史規律】\n${memories}`)
  }

  return parts.join('')
}

function buildTechnicalPrompt(s: TechnicalSnapshot): string {
  return `【${s.symbol} ${s.name}】
現價: ${s.currentPrice}
均線: MA5=${s.ma5 ?? 'N/A'} | MA20=${s.ma20 ?? 'N/A'} | MA60=${s.ma60 ?? 'N/A'}
動能: RSI14=${s.rsi14?.toFixed(1) ?? 'N/A'} | MACD=${s.macd?.toFixed(3) ?? 'N/A'} | Signal=${s.macdSignal?.toFixed(3) ?? 'N/A'} | Hist=${s.macdHist?.toFixed(3) ?? 'N/A'}
布林: Upper=${s.bbUpper?.toFixed(2) ?? 'N/A'} | Mid=${s.bbMid?.toFixed(2) ?? 'N/A'} | Lower=${s.bbLower?.toFixed(2) ?? 'N/A'}
ATR14: ${s.atr14?.toFixed(2) ?? 'N/A'}
因子分數: ${s.compositeScore?.toFixed(2) ?? 'N/A'} (Q${s.quantile ?? 'N/A'})
風險: Sharpe=${s.sharpeRatio?.toFixed(2) ?? 'N/A'} | MaxDD=${s.maxDrawdown?.toFixed(2) ?? 'N/A'}% | Beta=${s.beta?.toFixed(2) ?? 'N/A'} | VaR95=${s.var95?.toFixed(2) ?? 'N/A'}%
交易信號: ${s.tradeSignal ?? 'N/A'} | 進場=${s.entryPrice ?? 'N/A'} | 止損=${s.stopLoss ?? 'N/A'} | 目標1=${s.target1 ?? 'N/A'} | 目標2=${s.target2 ?? 'N/A'}`
}

// ─── Batch Recommendation Reasons（全部打包 1 次 Haiku call）──────────────────
export interface RecommendationCandidate {
  symbol: string
  name: string
  signal: string
  score: number
  score_components?: string | null
  chip_score: number
  tech_score: number
  momentum_score?: number | null
  ml_score: number
  ml_confidence: number
  ml_models_up: number
  ml_models_down: number
  ml_models_total: number
  rsi14: number | null
  macd_hist: number | null
  foreign_net_5d: number | null
  trust_net_5d: number | null
  current_price: number | null
}

export async function generateRecommendationReasons(
  apiKey: string,
  candidates: RecommendationCandidate[],
  topThemes: string[] = [],
): Promise<Map<string, { reason: string; watchPoints: string[] }>> {
  const result = new Map<string, { reason: string; watchPoints: string[] }>()
  if (!candidates.length) return result

  const system = `你是台灣股市資深分析師，負責為每日推薦清單撰寫具資訊量的推薦理由。
規則：
- 每支股票的 reason 限 120 字以內，必須使用 Score V2 finalScore 與五構面語意：ML Edge、Chip Flow、Technical Structure、Fundamental Quality、News/Theme
- 不准退回舊 chip_score / tech_score / ml_score 三分法，也不要只寫「籌碼、技術、ML」三面向
- watchPoints 給 3 條具體觀察重點，每條 60-100 字，必須含具體數字（價位/百分比/天數）
  例：「留意 58.8 月線支撐能否守住，跌破則 ATR 停損 56.08；上方 63.59 為 ML target1」
  例：「RSI 39 雖未進超賣，但連續 3 日量縮，需確認量能放大才轉強訊號」
  例：「外資 5 日淨買超 0.3 億偏弱，須觀察下週是否回補；投信若同步買進可加速推升」
- 語氣專業簡潔，不用「建議」「推薦」等字眼，改用「留意」「觀察」
- 若 ML 信心高(>0.6)，可強調模型共識；若低(<0.5)，強調需確認
- 必須回傳 JSON array，格式：[{"symbol":"2330","reason":"...","watchPoints":["...","...","..."]}]
- 長度必須和輸入股票數量完全一致`

  const stockList = candidates.map((c, i) => {
    const chipAmt = ((c.foreign_net_5d ?? 0) + (c.trust_net_5d ?? 0)).toFixed(1)
    const scoreV2 = readScoreV2Snapshot(c)
    return `${i + 1}. ${c.symbol} ${c.name} | signal=${c.signal} score=${scoreV2.finalScore}(base=${scoreV2.total}; ML Edge=${scoreV2.components.mlEdge}/25, Chip Flow=${scoreV2.components.chipFlow}/25, Technical Structure=${scoreV2.components.technicalStructure}/25, Fundamental Quality=${scoreV2.components.fundamentalQuality}/20, News/Theme=${scoreV2.components.newsTheme}/5) | ML投票${c.ml_models_up}↑/${c.ml_models_down}↓(共${c.ml_models_total}) conf=${(c.ml_confidence * 100).toFixed(0)}% | RSI=${c.rsi14?.toFixed(0) ?? 'N/A'} MACD${(c.macd_hist ?? 0) > 0 ? '多' : '空'} | 5日法人淨額${chipAmt}億 | 價${c.current_price ?? 'N/A'}`
  }).join('\n')

  const themeHint = topThemes.length ? `\n\n今日主流主題：${topThemes.join('、')}` : ''

  try {
    const raw = await callClaude(
      apiKey,
      system,
      `請為以下 ${candidates.length} 支推薦股票各寫一段推薦理由：\n${stockList}${themeHint}`,
      Math.min(8192, candidates.length * 500),  // 2026-04-07: bump from 250→500，allowing richer watchPoints (3 × 100 chars + reason)
      'sonnet',
      true,
    )

    const match = raw.match(/\[[\s\S]*\]/s)
    if (match) {
      const parsed: Array<{ symbol: string; reason: string; watchPoints: string[] }> = JSON.parse(match[0])
      for (const item of parsed) {
        if (item.symbol && item.reason) {
          result.set(item.symbol, {
            reason: item.reason.slice(0, 200),
            watchPoints: (item.watchPoints ?? []).slice(0, 3),
          })
        }
      }
    }
    console.log(`[LLM] 推薦理由生成完成：${result.size}/${candidates.length} 支`)
  } catch (e) {
    console.error('[LLM] 推薦理由生成失敗（使用 template fallback）:', e)
  }

  return result
}

// ─── Batch News Sentiment（5篇一批，省 80% API 呼叫次數）──────────────────────
export async function batchAnalyzeSentiment(
  apiKey: string,
  articles: Array<{ title: string; summary?: string | null }>,
): Promise<Array<'positive' | 'neutral' | 'negative'>> {
  if (!articles.length) return []

  const BATCH = 5
  const results: Array<'positive' | 'neutral' | 'negative'> = []

  for (let i = 0; i < articles.length; i += BATCH) {
    const chunk = articles.slice(i, i + BATCH)
    const numbered = chunk
      .map((a, j) => `${j + 1}. ${a.title}${a.summary ? ' — ' + a.summary.slice(0, 80) : ''}`)
      .join('\n')

    try {
      const raw = await callClaude(
        apiKey,
        '你是台灣股市新聞情感分析專家。請分析每則新聞標題的市場情感。' +
        '只回傳 JSON array，格式：["positive","neutral","negative",...]，' +
        '長度必須和輸入新聞數量完全一致，不要有任何其他文字。',
        `請分析以下 ${chunk.length} 則新聞的情感（positive/neutral/negative）：
${numbered}`,
        100,
      )

      // 解析 JSON
      const match = raw.match(/\[.*\]/s)
      if (match) {
        const parsed: string[] = JSON.parse(match[0])
        for (let k = 0; k < chunk.length; k++) {
          const v = parsed[k]
          results.push(v === 'positive' ? 'positive' : v === 'negative' ? 'negative' : 'neutral')
        }
      } else {
        // 解析失敗 → 全給 neutral
        results.push(...chunk.map(() => 'neutral' as const))
      }
    } catch {
      results.push(...chunk.map(() => 'neutral' as const))
    }
  }

  return results
}
