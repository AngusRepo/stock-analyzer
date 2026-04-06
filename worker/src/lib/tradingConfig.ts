/**
 * tradingConfig.ts — 統一交易參數管理
 *
 * 28 個可 runtime 調整的交易參數，存於 KV `trading:config`。
 * 讀取一次、快取 300s、fallback default。
 */

// ─── Type ────────────────────────────────────────────────────────────────────

export interface TradingConfig {
  fees: {
    commission: number     // 買賣手續費率（預設 0.001425 = 0.1425%）
    tax: number            // 賣出交易稅率（預設 0.003 = 0.3%）
    dayTradeTax: number    // 當沖賣出交易稅率（預設 0.0015 = 0.15%，減半至 2027 底）
    minCommission: number  // 最低手續費 NT$（預設 20）
  }
  circuit: {
    maxPositionPct: number       // 正常最大單一部位佔比（預設 0.08）
    buyConfThreshold: number     // 正常買入信心門檻（預設 0.60）
    sellConfThreshold: number    // 正常賣出信心門檻（預設 0.65）
    drawdownHalt: number         // 30 日回撤暫停閾值（預設 0.15）
    drawdownReducedPosPct: number // 回撤時縮減部位（預設 0.04）
    drawdownRaisedConf: number   // 回撤/低準確率時提高的信心門檻（預設 0.70）
    lowAccuracyThreshold: number // 模型準確率警戒線（預設 0.45）
    highVolReducedPosPct: number // 大盤高波動時縮減部位（預設 0.04）
    bullAlignmentThreshold: number // Layer4 多頭排列警戒線（預設 20）
  }
  exit: {
    hardStopPct: number          // 硬上限止損（預設 -0.12）
    fallbackInitStopMult: number // 無 ATR 時初始止損倍數（預設 0.93 = -7%）
    fallbackTp1Mult: number      // 無 ML 目標時 TP1 倍數（預設 1.03 = +3%）
    fallbackTp2Mult: number      // 無 ML 目標時 TP2 倍數（預設 1.06 = +6%）
    tp1SellRatio: number         // TP1 賣出比例（預設 0.5 = 50%）
    timeStopDays: number         // 時間止損天數（預設 20）
    timeStopMinProfit: number    // 時間止損最低獲利（預設 0.005）
    trailMultDefault: number     // Trailing stop 預設倍數（預設 3.0）
    trailMultAt3pct: number      // 獲利 >3% 時 trail 倍數（預設 2.5）
    trailMultAt8pct: number      // 獲利 >8% 時 trail 倍數（預設 2.0）
    fallbackAtrPct: number       // ATR 不可用時的替代 %（預設 0.02）
  }
  position: {
    dailyBuyLimit: number        // 每日自動買入上限 NT$（預設 200000）
    manualDailyLimit: number     // 每日手動買入上限 NT$（預設 200000）
    maxPctOfPortfolio: number    // 單筆最大佔 portfolio %（預設 0.25）
    maxPctOfCash: number         // 單筆最大佔現金 %（預設 0.30）
    minCashToTrade: number       // 最低可交易現金（預設 10000）
    minStopPct: number           // 最低停損 %（預設 0.03）
    partialFillThreshold: number // 佔日均量超過此比例 → partial fill（預設 0.05 = 5%）
    partialFillRate: number      // 超過部分的未成交比例（預設 0.2 = 80% fill）
    maxPositions: number         // 最大持有部位數（預設 5）
    riskPctPerTrade: number      // 每筆交易風險佔 portfolio %（預設 0.015）
    minPositionValue: number     // 最低部位金額（預設 30000）
    maxDailySwaps: number        // 每日最大換股次數（預設 1）
    swapThreshold: number        // 換股評分門檻倍數（預設 1.15）
    swapMinHoldDays: number      // 換股最低持有天數（預設 3）
  }
  screener: {
    minPrice: number             // 最低股價（預設 15）
    maxPrice: number             // 最高股價（預設 2000）
    minAvgVolume: number         // 最低日均量（預設 300000 shares）
    minDailyTurnover: number     // 最低日均成交金額（預設 5000000 = 500萬，Survivorship Bias 防護）
    max5dDrop: number            // 最大 5 日跌幅（預設 -0.10）
    minVolRatio: number          // 動量掃描最低量比（預設 1.2）
    strongVolRatio: number       // 量能放大標記門檻（預設 1.5）
    minMomReturn: number         // 動量最低 5 日漲幅（預設 0.005）
    minMomAvgVol: number         // 動量最低均量（預設 50000）
    topNPerSector: number        // 每族群取 top N（預設 8）
    topNMomentum: number         // 動量 top N（預設 15）
    maxCandidates: number        // Bottom-up 最終候選上限（預設 25）
    maxPerIndustry: number       // 同官方產業上限（預設 5）
    correlationThreshold: number // 報酬率去重門檻（預設 0.8）
    correlationWindow: number    // 去重計算天數（預設 60）
    chipScoreTiers: number[]     // 籌碼分級分數（預設 [36,28,20,12,5]）
    chipIntensityThresholds: number[] // 籌碼強度門檻（預設 [0.20,0.10,0.05,0,-0.05]）
    consecBuyBonusTiers: number[]    // 連續買超加分（預設 [4,2]，對應 >=5天, >=3天）
    consecBuyDayThresholds: number[] // 連續買超天數門檻（預設 [5,3]）
    rsiScoreTiers: number[]          // RSI 分級分數（預設 [12,8,6,8,3]）
    macdNegativeFactor: number       // MACD 負值比較因子（預設 0.5）
    keltnerMultiplier: number        // 肯特納通道 ATR 倍數（預設 1.5）
    natrThreshold: number            // NATR 低波動門檻（預設 3）
    excessReturnRange: number[]      // 超額報酬 normalize 範圍（預設 [-0.03, 0.05]）
    volRatioRange: number[]          // 量比 normalize 範圍（預設 [0.7, 2.5]）
  }
  rrg: {
    leadingBonus: number         // Leading 象限加分（預設 10）
    improvingBonus: number       // Improving 象限加分（預設 7）
    weakeningBonus: number       // Weakening 象限加分（預設 0）
    laggingPenalty: number       // Lagging 象限扣分（預設 -5）
  }
  barrier: {
    upperMult: number            // 停利 ATR 倍數（預設 3.0）— Optuna #1 搜尋
    lowerMult: number            // 停損 ATR 倍數（預設 2.0）
    upperPctCap: number          // 停利百分比封頂（預設 0.07）
    lowerPctCap: number          // 停損百分比封頂（預設 0.03）
    maxDays: number              // 最大持有天數（預設 20）
  }
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  fees: {
    commission: 0.001425,
    tax: 0.003,
    dayTradeTax: 0.0015,
    minCommission: 20,
  },
  circuit: {
    maxPositionPct: 0.08,
    buyConfThreshold: 0.60,
    sellConfThreshold: 0.65,
    drawdownHalt: 0.15,
    drawdownReducedPosPct: 0.04,
    drawdownRaisedConf: 0.70,
    lowAccuracyThreshold: 0.45,
    highVolReducedPosPct: 0.04,
    bullAlignmentThreshold: 20,
  },
  exit: {
    hardStopPct: -0.10,
    fallbackInitStopMult: 0.93,
    fallbackTp1Mult: 1.03,
    fallbackTp2Mult: 1.06,
    tp1SellRatio: 0.5,
    timeStopDays: 20,
    timeStopMinProfit: 0.005,
    trailMultDefault: 3.0,
    trailMultAt3pct: 2.5,
    trailMultAt8pct: 2.0,
    fallbackAtrPct: 0.02,
  },
  position: {
    dailyBuyLimit: 200_000,
    manualDailyLimit: 200_000,
    maxPctOfPortfolio: 0.25,
    maxPctOfCash: 0.30,
    minCashToTrade: 10_000,
    minStopPct: 0.03,
    partialFillThreshold: 0.05,
    partialFillRate: 0.2,
    // P1#12: Portfolio Construction
    maxPositions: 5,              // hard cap on total positions
    riskPctPerTrade: 0.015,       // 1.5% of portfolio risk per trade (ATR fixed-risk)
    minPositionValue: 30_000,     // below this not worth transaction cost
    maxDailySwaps: 1,             // max position replacements per day
    swapThreshold: 1.15,          // new score must exceed weakest × 1.15
    swapMinHoldDays: 3,           // don't swap positions held < 3 days
  },
  screener: {
    minPrice: 15,
    maxPrice: 2000,
    minAvgVolume: 300_000,
    minDailyTurnover: 5_000_000,  // 500 萬：排除殭屍股但保留小型黑馬
    max5dDrop: -0.10,
    minVolRatio: 1.2,
    strongVolRatio: 1.5,
    minMomReturn: 0.005,
    minMomAvgVol: 50_000,
    topNPerSector: 8,
    topNMomentum: 15,
    maxCandidates: 25,
    maxPerIndustry: 5,
    correlationThreshold: 0.8,
    correlationWindow: 60,
    chipScoreTiers: [36, 28, 20, 12, 5],
    chipIntensityThresholds: [0.20, 0.10, 0.05, 0, -0.05],
    consecBuyBonusTiers: [4, 2],
    consecBuyDayThresholds: [5, 3],
    rsiScoreTiers: [12, 8, 6, 8, 3],
    macdNegativeFactor: 0.5,
    keltnerMultiplier: 1.5,
    natrThreshold: 3,
    excessReturnRange: [-0.03, 0.05],
    volRatioRange: [0.7, 2.5],
  },
  rrg: {
    leadingBonus: 10,
    improvingBonus: 7,
    weakeningBonus: 0,
    laggingPenalty: -5,
  },
  barrier: {
    upperMult: 3.0,
    lowerMult: 2.0,
    upperPctCap: 0.07,
    lowerPctCap: 0.03,
    maxDays: 20,
  },
}

// ─── KV 讀取（300s cache）──────────────────────────────────────────────────

const KV_KEY = 'trading:config'
const CACHE_TTL_MS = 300_000  // 5 min in-memory cache

let _cached: TradingConfig | null = null
let _cachedAt = 0

/** Deep merge: KV 值覆蓋 defaults，缺失欄位自動 fallback */
function mergeConfig(partial: Partial<any>): TradingConfig {
  const d = DEFAULT_TRADING_CONFIG
  return {
    fees: { ...d.fees, ...partial.fees },
    circuit: { ...d.circuit, ...partial.circuit },
    exit: { ...d.exit, ...partial.exit },
    position: { ...d.position, ...partial.position },
    screener: { ...d.screener, ...partial.screener },
    rrg: { ...d.rrg, ...partial.rrg },
    barrier: { ...d.barrier, ...partial.barrier },
  }
}

export async function getTradingConfig(kv: KVNamespace): Promise<TradingConfig> {
  // In-memory cache（同一個 Worker isolate 內有效）
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached

  try {
    const raw = await kv.get(KV_KEY, 'json') as Partial<TradingConfig> | null
    _cached = raw ? mergeConfig(raw) : DEFAULT_TRADING_CONFIG
  } catch {
    _cached = DEFAULT_TRADING_CONFIG
  }
  _cachedAt = Date.now()
  return _cached
}

/** 寫入 KV（admin API 用）+ 清除 cache */
export async function setTradingConfig(kv: KVNamespace, config: TradingConfig): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(config))
  _cached = config
  _cachedAt = Date.now()
}

/** 強制清除 in-memory cache（deploy 後或手動 reset） */
export function invalidateConfigCache(): void {
  _cached = null
  _cachedAt = 0
}
