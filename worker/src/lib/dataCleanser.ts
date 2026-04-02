/**
 * dataCleanser.ts — 資料清洗與候選去重
 *
 * Phase 1 功能：
 *   1. 缺值規則（Missing Value Rules）
 *   2. Hampel Filter（偵測時序異常值）
 *   3. Winsorization（極端值截斷）
 *   4. Sector/Group 去重（同質候選剔除）
 *   5. Rule-based Pre-ML Score（門檻篩選）
 */

import type { ScreenerCandidate } from './marketScreener'

// ─── Types ──────────────────────────────────────────────────────────────────

interface PriceBar {
  close: number
  max: number
  min: number
  Trading_Volume: number
  [key: string]: unknown
}

interface ChipNets {
  foreign: number
  trust: number
}

export interface CleansingReport {
  inputCount: number
  outputCount: number
  removed: {
    missingData: string[]
    hampelOutlier: string[]
    sectorDedup: string[]
    preMlFilter: string[]
  }
  winsorized: string[]
}

// ─── 1. Missing Value Rules ─────────────────────────────────────────────────

/**
 * 缺值規則：
 * - 至少 3 天 price data
 * - close > 0
 * - volume > 0（至少最新一天有量）
 */
export function hasSufficientData(
  prices: PriceBar[] | undefined,
  minDays: number = 3,
): boolean {
  if (!prices || prices.length < minDays) return false
  const latest = prices[prices.length - 1]
  if (!latest || latest.close <= 0) return false
  if (latest.Trading_Volume <= 0) return false
  return true
}

/**
 * 計算缺值比例
 * 回傳 0~1，超過閾值應排除
 */
export function missingRatio(prices: PriceBar[], expectedDays: number = 5): number {
  if (!prices.length) return 1
  const validDays = prices.filter(p => p.close > 0 && p.Trading_Volume > 0).length
  return 1 - validDays / expectedDays
}

// ─── 2. Hampel Filter ───────────────────────────────────────────────────────

/**
 * Hampel Filter：用 rolling median ± k * MAD 偵測異常值
 * 適合金融時序特徵，比 z-score 更穩健（不受極端值影響 median）
 *
 * @param values 數值陣列
 * @param windowSize 滑動窗口大小（單邊，實際窗口 = 2*windowSize+1）
 * @param k MAD 倍數（越小越嚴格，預設 3）
 * @returns { cleaned: 清洗後的值, outlierIndices: 異常值索引 }
 */
export function hampelFilter(
  values: number[],
  windowSize: number = 2,
  k: number = 3,
): { cleaned: number[]; outlierIndices: number[] } {
  const n = values.length
  const cleaned = [...values]
  const outlierIndices: number[] = []

  if (n < 2 * windowSize + 1) return { cleaned, outlierIndices }

  for (let i = windowSize; i < n - windowSize; i++) {
    const window = values.slice(i - windowSize, i + windowSize + 1)
    const sorted = [...window].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]

    // MAD = median of |x_i - median|
    const deviations = window.map(v => Math.abs(v - median)).sort((a, b) => a - b)
    const mad = deviations[Math.floor(deviations.length / 2)]

    // 1.4826 * MAD ≈ standard deviation for normal distribution
    const threshold = k * 1.4826 * mad

    if (threshold > 0 && Math.abs(values[i] - median) > threshold) {
      cleaned[i] = median  // 用 median 替換異常值
      outlierIndices.push(i)
    }
  }

  return { cleaned, outlierIndices }
}

/**
 * 對 price bars 的 close 序列做 Hampel filter
 * 回傳是否有異常值以及被清洗的天數
 */
export function hampelCheckPrices(prices: PriceBar[]): {
  hasOutlier: boolean
  outlierCount: number
  cleanedCloses: number[]
} {
  const closes = prices.map(p => p.close)
  const { cleaned, outlierIndices } = hampelFilter(closes, 2, 3)
  return {
    hasOutlier: outlierIndices.length > 0,
    outlierCount: outlierIndices.length,
    cleanedCloses: cleaned,
  }
}

/**
 * 對 volume 序列做 Hampel filter（量能異常偵測）
 */
export function hampelCheckVolumes(prices: PriceBar[]): {
  hasOutlier: boolean
  outlierCount: number
  cleanedVolumes: number[]
} {
  const volumes = prices.map(p => p.Trading_Volume)
  const { cleaned, outlierIndices } = hampelFilter(volumes, 2, 3)
  return {
    hasOutlier: outlierIndices.length > 0,
    outlierCount: outlierIndices.length,
    cleanedVolumes: cleaned,
  }
}

// ─── 3. Winsorization ───────────────────────────────────────────────────────

/**
 * Winsorize：將超出 [p_low, p_high] 百分位的值截斷到邊界
 * 不刪除資料，只壓平極端值
 *
 * @param values 數值陣列
 * @param lowerPct 下界百分位（預設 0.05 = 5th percentile）
 * @param upperPct 上界百分位（預設 0.95 = 95th percentile）
 */
export function winsorize(
  values: number[],
  lowerPct: number = 0.05,
  upperPct: number = 0.95,
): { winsorized: number[]; lowerBound: number; upperBound: number; clippedCount: number } {
  if (!values.length) return { winsorized: [], lowerBound: 0, upperBound: 0, clippedCount: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const lowerIdx = Math.floor(sorted.length * lowerPct)
  const upperIdx = Math.ceil(sorted.length * upperPct) - 1
  const lowerBound = sorted[Math.max(0, lowerIdx)]
  const upperBound = sorted[Math.min(sorted.length - 1, upperIdx)]

  let clippedCount = 0
  const winsorized = values.map(v => {
    if (v < lowerBound) { clippedCount++; return lowerBound }
    if (v > upperBound) { clippedCount++; return upperBound }
    return v
  })

  return { winsorized, lowerBound, upperBound, clippedCount }
}

/**
 * 對籌碼數據做 Winsorize
 * 籌碼的極端值（例如某天外資大買 50 億）會嚴重扭曲評分
 */
export function winsorizeChips(
  chipValues: number[],
): { winsorized: number[]; clippedCount: number } {
  // 籌碼用更寬的 percentile（金融數據本來就偏態）
  const result = winsorize(chipValues, 0.02, 0.98)
  return { winsorized: result.winsorized, clippedCount: result.clippedCount }
}

// ─── 4. Sector/Group Dedup ──────────────────────────────────────────────────

interface DedupCandidate extends ScreenerCandidate {
  returnPct?: number
  avgVolume?: number
}

/**
 * 同族群去重：同一個 sector 內，如果兩檔股票的 5 日報酬率相關性很高
 * （價格走勢幾乎一樣），只保留分數最高的那檔
 *
 * 簡化版：同 sector 內，報酬率差距 < 1% 且分數差 < 5 的，只留一檔
 */
export function deduplicateBySector(
  candidates: DedupCandidate[],
  maxPerSector: number = 6,
): { deduped: ScreenerCandidate[]; removed: string[] } {
  const removed: string[] = []
  const bySector = new Map<string, DedupCandidate[]>()

  for (const c of candidates) {
    const sector = c.sector.startsWith('動量_') ? c.sector : c.sector
    if (!bySector.has(sector)) bySector.set(sector, [])
    bySector.get(sector)!.push(c)
  }

  const deduped: ScreenerCandidate[] = []

  for (const [sector, group] of bySector) {
    // 按分數排序
    group.sort((a, b) => b.score - a.score)

    const kept: DedupCandidate[] = []
    for (const candidate of group) {
      // 檢查跟已保留的是否太相似
      const isDuplicate = kept.some(k =>
        k.returnPct !== undefined &&
        candidate.returnPct !== undefined &&
        Math.abs(k.returnPct - candidate.returnPct) < 0.01 &&
        Math.abs(k.score - candidate.score) < 5
      )

      if (isDuplicate) {
        removed.push(candidate.symbol)
      } else if (kept.length < maxPerSector) {
        kept.push(candidate)
      } else {
        removed.push(candidate.symbol)
      }
    }

    deduped.push(...kept)
  }

  return { deduped, removed }
}

// ─── 5. Rule-based Pre-ML Score ─────────────────────────────────────────────

interface PreMlCheckResult {
  pass: boolean
  score: number        // 0-100 粗略分
  failReasons: string[]
}

/**
 * Pre-ML 快速評分：在送 ML 之前做一次粗篩
 * 目的：減少 ML 需要處理的數量，避免 timeout
 *
 * 不需要複雜模型，純 rule-based：
 * - 籌碼面基本健康度（外資投信非大幅賣超）
 * - 技術面基本方向（不在自由落體）
 * - 量能基本活絡度
 */
export function preMlScore(
  prices: PriceBar[],
  chips: Map<string, ChipNets> | undefined,
  screenScore: number,
): PreMlCheckResult {
  const failReasons: string[] = []
  let score = 0

  if (prices.length < 3) {
    return { pass: false, score: 0, failReasons: ['資料不足 3 天'] }
  }

  const latest = prices[prices.length - 1]
  const oldest = prices[0]

  // ① 基本趨勢方向 (0-30)
  const return5d = oldest.close > 0
    ? (latest.close - oldest.close) / oldest.close
    : 0

  if (return5d < -0.15) {
    failReasons.push(`5日跌幅 ${(return5d * 100).toFixed(1)}% 過大`)
  } else if (return5d > -0.05) {
    score += 20 + Math.min(10, return5d * 100) // 漲越多分越高，最多 30
  } else {
    score += 10
  }

  // ② 量能活絡 (0-20)
  const avgVol = prices.reduce((s, p) => s + p.Trading_Volume, 0) / prices.length
  if (avgVol < 100_000) {
    failReasons.push(`均量 ${Math.round(avgVol)} 過低`)
  } else if (avgVol > 300_000) {
    score += 20
  } else {
    score += 10
  }

  // ③ 最新收盤不能太離譜 (0-10)
  if (latest.close > 0 && latest.min > 0) {
    const intraRange = (latest.max - latest.min) / latest.close
    if (intraRange > 0.095) {
      // 當日振幅 > 9.5% = 可能漲停或跌停，異常
      score += 2
    } else {
      score += 10
    }
  }

  // ④ 籌碼方向 (0-20)
  if (chips) {
    const sortedDates = [...chips.keys()].sort()
    const recent = sortedDates.slice(-3)
    let netBuy = 0
    for (const d of recent) {
      const nets = chips.get(d)!
      netBuy += nets.foreign + nets.trust
    }
    if (netBuy > 0) score += 20
    else if (netBuy > -5e7) score += 10
    else failReasons.push('法人近 3 日大幅賣超')
  } else {
    score += 5  // 無籌碼資料，給基本分
  }

  // ⑤ Screener 分數加權 (0-20)
  score += Math.min(20, screenScore / 5)

  // 通過條件：score >= 25 且無致命 failReason
  const pass = score >= 25 && failReasons.length === 0

  return { pass, score: Math.round(score), failReasons }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface CleansedResult {
  candidates: ScreenerCandidate[]
  report: CleansingReport
}

/**
 * 完整清洗 pipeline：
 * 1. 缺值過濾
 * 2. Hampel Filter 異常偵測（標記，不刪除）
 * 3. Winsorization（截斷極端值）
 * 4. Sector 去重
 * 5. Pre-ML Score 過濾
 */
export function cleanseAndFilter(
  candidates: ScreenerCandidate[],
  priceData: Map<string, PriceBar[]>,
  chipData: Map<string, Map<string, ChipNets>>,
  maxCandidates: number = 25,
): CleansedResult {
  const report: CleansingReport = {
    inputCount: candidates.length,
    outputCount: 0,
    removed: {
      missingData: [],
      hampelOutlier: [],
      sectorDedup: [],
      preMlFilter: [],
    },
    winsorized: [],
  }

  // Step 1: 缺值過濾
  let filtered = candidates.filter(c => {
    const prices = priceData.get(c.symbol)
    if (!hasSufficientData(prices)) {
      report.removed.missingData.push(c.symbol)
      return false
    }
    return true
  })

  // Step 2: Hampel Filter — 標記但不刪除（異常價格用 median 替代計算）
  const hampelFlagged: string[] = []
  for (const c of filtered) {
    const prices = priceData.get(c.symbol)!
    const { hasOutlier, outlierCount } = hampelCheckPrices(prices)
    if (hasOutlier) {
      hampelFlagged.push(c.symbol)
      // 嚴重異常（超過一半天數是異常）才排除
      if (outlierCount > prices.length / 2) {
        report.removed.hampelOutlier.push(c.symbol)
      }
    }
  }
  filtered = filtered.filter(c => !report.removed.hampelOutlier.includes(c.symbol))

  // Step 3: Winsorization — 對跨候選的 score 做截斷
  if (filtered.length > 5) {
    const scores = filtered.map(c => c.score)
    const { winsorized: wScores, clippedCount } = winsorize(scores, 0.05, 0.95)
    if (clippedCount > 0) {
      filtered.forEach((c, i) => {
        if (c.score !== wScores[i]) {
          report.winsorized.push(c.symbol)
          c.score = Math.round(wScores[i] * 10) / 10
        }
      })
    }
  }

  // Step 4: Sector 去重
  // 計算每檔的 5 日報酬率供去重比較
  const withReturn: DedupCandidate[] = filtered.map(c => {
    const prices = priceData.get(c.symbol)
    let returnPct: number | undefined
    if (prices && prices.length >= 2) {
      const oldest = prices[0]
      const latest = prices[prices.length - 1]
      if (oldest.close > 0) {
        returnPct = (latest.close - oldest.close) / oldest.close
      }
    }
    return { ...c, returnPct }
  })

  const { deduped, removed: dedupRemoved } = deduplicateBySector(withReturn, 6)
  report.removed.sectorDedup = dedupRemoved

  // Step 5: Pre-ML Score
  const preMlPassed: ScreenerCandidate[] = []
  for (const c of deduped) {
    const prices = priceData.get(c.symbol)!
    const chips = chipData.get(c.symbol)
    const { pass, failReasons } = preMlScore(prices, chips, c.score)
    if (pass) {
      preMlPassed.push(c)
    } else {
      report.removed.preMlFilter.push(c.symbol)
    }
  }

  // 按分數排序，取 top N
  preMlPassed.sort((a, b) => b.score - a.score)
  const finalCandidates = preMlPassed.slice(0, maxCandidates)

  report.outputCount = finalCandidates.length

  return { candidates: finalCandidates, report }
}
