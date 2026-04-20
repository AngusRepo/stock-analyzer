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
    // ── Sprint 4-1: L2 drawdown scaling 常數 ───────────────────────────────
    drawdownScaleStart: number   // 開始縮減部位的回撤起點（預設 0.03）
    mddMultFloor: number         // mddMultiplier 下限（預設 0.2 = 縮到 20%）
    // ── 2026-04-18 #36 paper.ts hardcode 一次到位 ───────────────────────────
    lockedDropPct: number              // 鎖股判定跌幅（預設 -0.095，台股日限 ~-9.5%）
    lockedVolRatio: number             // 鎖股低量判定（預設 0.1 = 10% 前日量）
    drawdownConfTriggerRatio: number   // drawdown 超過 halt × N 時提高 conf 門檻（預設 0.5 = halt 一半）
    defaultAccuracy: number            // 無歷史時預設準確率 fallback（預設 0.5）
    layer7ScaleRatio: number           // Layer7 SCALE（連 4/5 錯）maxPositionPct 縮減倍數（預設 0.3）
    preMarketGapThreshold: number      // 盤前隱含 gap 觸發 risk gate（預設 0.05）
    limitUpPct: number                 // 漲停判定（預設 0.095）
    limitDownPct: number               // 跌停判定（預設 -0.095）
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
    // ── Sprint 3 P0-1: Kelly Position Sizing ────────────────────────────────
    kelly: {
      enabled: boolean         // feature flag（預設 false，安全上線）
      halfKelly: boolean       // 半 Kelly（預設 true，保守）
      confClipLo: number       // ML confidence 下限 clip（預設 0.50，防 overconfident）
      confClipHi: number       // ML confidence 上限 clip（預設 0.75）
      maxKellyPct: number      // Kelly % 上限 hard cap（預設 0.15 = 15%）
    }
    // ── Sprint 4-1: Paper.ts L3 hardcode 接 KV ─────────────────────────────
    swapWeights: {
      pnl: number              // swap pnlScore 權重（預設 0.35）
      time: number             // swap timeScore 權重（預設 0.25）
      tp1: number              // swap tp1_hit 懲罰權重（預設 0.20）
      loss: number             // swap 虧損懲罰權重（預設 0.20）
      // 2026-04-18 #36 Round 2: swap scoring magic numbers
      tp1NotHitPenalty: number   // tp1 沒命中時基礎懲罰分（預設 40）
      lossPenalty: number        // pnl 為負時加扣（預設 20）
      tp1MissMultiplier: number  // tp1 命中後折扣因子（預設 0.5 → 1 - 0.5 = 0.5 剩餘懲罰）
    }
    tp1ProximityRatio: number  // 接近 tp1 判定比例（預設 0.97）
    requoteDeviationMax: number  // 重掛 entry 偏離容忍（預設 0.05）
    requoteDiscount: number      // 重掛新 entry 折扣（預設 0.985）
    requoteStopFallback: number  // ml_stop_loss fallback 係數（預設 0.92）
    // ── 2026-04-18 #36: calcRiskPct tiers 從 paper.ts hardcode 搬過來 ──────
    riskPctBaseline: number                // 預設一般信號 risk（預設 0.01 = 1%）
    riskPctBuy: number                     // BUY 且 conf≥buyConf 時（預設 0.015 = 1.5%）
    riskPctStrongBuy: number               // STRONG_BUY 且 conf≥strongConf 時（預設 0.02 = 2%）
    riskPctBuyConfThreshold: number        // riskPctBuy 門檻（預設 0.70）
    riskPctStrongBuyConfThreshold: number  // riskPctStrongBuy 門檻（預設 0.80）
    downgradeRiskMultiplier: number        // DOWNGRADE verdict → riskPct × N（預設 0.5 半倉）
    // 2026-04-18 #36 Round 2 (補齊至 26)
    gapChaseBuffer: number                 // gap-aware 追價 buffer（預設 0.995 = 留 0.5%）
    fillSlippageTicks: number              // 預設下單滑價 tick 數（預設 1）
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
    // ── 2026-04-18 #36: paper.ts T2 confidence adj hardcodes ──────────────
    leadingNegMomConfAdj: number   // Leading 但 momentum<0 時 conf 調整（預設 -0.03）
    improvingConfAdj: number       // Improving 象限 conf 調整（預設 -0.02）
  }
  barrier: {
    upperMult: number            // 停利 ATR 倍數（預設 3.0）— Optuna #1 搜尋
    lowerMult: number            // 停損 ATR 倍數（預設 2.0）
    upperPctCap: number          // 停利百分比封頂（預設 0.07）
    lowerPctCap: number          // 停損百分比封頂（預設 0.03）
    maxDays: number              // 最大持有天數（預設 20）
  }
  // ── Sprint 3 P0-4: Hybrid Ranking (Architecture C) ─────────────────────────
  // Why: 解決 "filter 後 0 BUY signal" 問題。combined_score = α*screener + β*ml_conf + γ*signal_tier
  //      若 has_buy_signal 數量 < topK，用 combined_score 排序 promote 到 has_buy_signal=1
  // α/β/γ 未來 Sprint 7+ 用 Optuna 搜；目前 hardcode 合理 default
  ranking: {
    enabled: boolean             // feature flag（預設 true，直接解 0-signal 問題）
    topK: number                 // 目標持有部位數（預設 3，對齊 paper.ts morningSetup LIMIT 3）
    alpha: number                // screener weight 預設 0.40
    beta: number                 // ml_confidence weight 預設 0.40
    gamma: number                // signal_tier weight 預設 0.20
    screenerDenominator: number  // (chip+tech) 正規化分母（預設 60）
    promoteMinConf: number       // promoted row 的 confidence 保底（預設 0.60，對齊 buyConfThreshold）
  }
  // ── 2026-04-07 added: Optuna #2 Signal 月搜結果 destination ────────────────
  // 之前寫進 ml:adaptive_params 是錯的（adaptive_params 應該只裝 daily delta）
  signal: {
    strongSignalScore: number    // STRONG_BUY 門檻（預設 0.72）
    buySignalScore: number       // BUY 門檻（預設 0.52） — Optuna 月搜的 baseline
    holdSignalScore: number      // HOLD 門檻（預設 0.36）
    consensusThreshold: number   // 共識門檻（預設 0.60）
    // ── 2026-04-18 #36: news analyst hardcode ─────────────────────────────
    newsNegativeConfThreshold: number  // 新聞 bias=negative 觸發 conf 門檻（預設 0.5）
    newsNegativeConfBoost: number      // 觸發時 buyConfThreshold 上調量（預設 0.05）
    newsNegativeConfCap: number        // 上調後 buyConfThreshold 硬上限（預設 0.75）
  }
  // ── 2026-04-07 added: Optuna #3 SL/TP 月搜結果 destination ─────────────────
  // 之前 sl_mult_base/tp_mult_base 寫進 ml:adaptive_params 是錯的
  sltp: {
    slMultBase: number           // SL × ATR 倍數 baseline（預設 2.0）
    tpMultBase: number           // TP × ATR 倍數 baseline（預設 1.5）
    trailSwitch3pct: number      // profit-lock 第一階觸發 (預設 0.03)
    trailSwitch8pct: number      // profit-lock 第二階觸發 (預設 0.08)
    volThresholdLow: number      // 低波動定義 (預設 0.015)
    volThresholdHigh: number     // 高波動定義 (預設 0.03)
    // ── Sprint 5.1 Phase 7 Layer B (2026-04-09): per-vol-branch multipliers ──
    // 原本 ensemble.py 內部 hardcode 0.75/0.67/1.25/1.33，從沒進 Optuna search space
    // 預設值等同原 hardcode，behaviour 不變；進 Optuna 後可 tune
    slMultLow: number            // 低波動 SL 倍率相對 base（預設 0.75）
    tpMultLow: number            // 低波動 TP 倍率相對 base（預設 0.67）
    slMultHigh: number           // 高波動 SL 倍率相對 base（預設 1.25）
    tpMultHigh: number           // 高波動 TP 倍率相對 base（預設 1.33）
    // ── Sprint 5.1 Phase 7 Layer C (2026-04-09): extreme low vol skip ───────
    volSkipThreshold: number     // vol_pct < threshold → NO_SIGNAL (預設 0.005)
    // ── 2026-04-18 #36: TP2 multiplier from paper.ts hardcode ──────────────
    tp2DistanceMultiplier: number  // TP2 = entry + atr × tpMult × N（預設 2.0 = TP2 是 TP1 兩倍距離）
  }
  // ── 2026-04-07 added: L2 daily formula 內部係數（adaptive.py 用） ──────────
  // 把 hardcoded formula 常數搬到 KV，讓未來 Optuna 可搜
  L2_formula: {
    // confidence delta formula: delta = risk * risk_mult + (0.6 - acc) * perf_mult
    confidence_risk_mult: number      // 預設 0.15
    confidence_perf_mult: number      // 預設 0.20
    confidence_delta_clip_lo: number  // 預設 -0.10
    confidence_delta_clip_hi: number  // 預設 +0.20
    // effective clip 套在 baseline + delta 上
    confidence_effective_clip_lo: number  // 預設 0.45（注意：原 hardcode 0.55）
    confidence_effective_clip_hi: number  // 預設 0.75
    // SL/TP 加碼（per market_risk_level）
    sltp_add_orange_sl: number     // 預設 0.3
    sltp_add_orange_tp: number     // 預設 0.3
    sltp_add_red_sl: number        // 預設 0.5
    sltp_add_red_tp: number        // 預設 0.5
    sltp_add_black_sl: number      // 預設 1.0
    sltp_add_black_tp: number      // 預設 0.5
    // Bandit protection
    bandit_loss_thresh_high: number   // 預設 0.6 (虧損率)
    bandit_loss_thresh_med: number    // 預設 0.4
    bandit_max_mult_high: number      // 預設 1.5
    bandit_max_mult_med: number       // 預設 2.0
    bandit_max_mult_low: number       // 預設 2.5
    // PF quality 加權
    pf_quality_30d_weight: number     // 預設 0.7
    pf_quality_90d_weight: number     // 預設 0.3
    pf_quality_clip_lo: number        // 預設 0.3
    pf_quality_clip_hi: number        // 預設 1.8
    // ── Sprint 4-1: 盤前夜盤 RiskGate + medium risk sizing ──────────────────
    night_drop_severe_pct: number      // 夜盤嚴重跌幅（預設 -1.5 = -1.5%）
    night_drop_mild_pct: number        // 夜盤中度跌幅（預設 -0.8 = -0.8%）
    night_drop_severe_adjust: number   // 嚴重跌 entry 調整（預設 0.98 = -2%）
    night_drop_mild_adjust: number     // 中度跌 entry 調整（預設 0.99 = -1%）
    medium_risk_scale: number          // market_risk=medium 時倉位縮放（預設 0.5）
  }
  // ── Sprint 5.2+: Intraday Re-score 安控 ───────────────────────────────────
  // 盤中 10:00/12:00 call ml-controller /intraday/rescore，對持倉 confidence 衰減
  // 隔夜持倉可自動出場；當日持倉只能 WARN（當沖白名單限制）
  // See memory/project_instance_scaling_brainstorm.md Part A
  intraday: {
    rescoreEnabled: boolean              // feature flag（預設 true）
    rescoreExitThreshold: number         // confidence 低於此值 → EXIT（預設 0.40）
    rescoreWarnThreshold: number         // confidence 低於此值 → WARN（預設 0.55）
    rescoreDecaySensitivity: number      // 每 1% 反向價格變動的 confidence 衰減倍數（預設 5.0）
    rescoreCooldownMin: number           // 同一檔 re-score 觸發後 N 分鐘內不再觸發（預設 60）
    maxRescoreExitsPerDay: number        // 每日最多 re-score 觸發出場次數（預設 2）
  }
  // ── F4: Intraday Momentum Confirmation（買入二次確認）─────────────────────
  momentum: {
    minVolumeRatio: number               // 最低 volume ratio vs 20d avg（預設 0.8）
    minRangePosition: number             // 最低 day range position（預設 0.3 = 30%）
    // 2026-04-18 #36 Round 2
    tradingDayMinutes: number            // 台股交易時段分鐘數（預設 270 = 9:00-13:30）
    minutesFractionFloor: number         // minutesSinceOpen/total 下限（預設 0.1 防早盤分母太小）
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
    // Sprint 4-1
    drawdownScaleStart: 0.03,
    mddMultFloor: 0.2,
    // 2026-04-18 #36
    lockedDropPct: -0.095,
    lockedVolRatio: 0.1,
    drawdownConfTriggerRatio: 0.5,
    defaultAccuracy: 0.5,
    layer7ScaleRatio: 0.3,
    preMarketGapThreshold: 0.05,
    limitUpPct: 0.095,
    limitDownPct: -0.095,
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
    // Sprint 3 P0-1: Kelly (default OFF; flip in KV when ready)
    kelly: {
      enabled: false,
      halfKelly: true,
      confClipLo: 0.50,
      confClipHi: 0.75,
      maxKellyPct: 0.15,
    },
    // ── Sprint 4-1: Paper.ts L3 hardcode 接 KV ─────────────────────────────
    swapWeights: {
      pnl: 0.35,          // pnlScore 權重（預設 0.35）
      time: 0.25,         // timeScore 權重（預設 0.25）
      tp1: 0.20,          // tp1_hit 懲罰權重（預設 0.20）
      loss: 0.20,         // 虧損懲罰權重（預設 0.20）
      // Round 2
      tp1NotHitPenalty: 40,
      lossPenalty: 20,
      tp1MissMultiplier: 0.5,
    },
    tp1ProximityRatio: 0.97,    // 接近 tp1 判定比例（預設 0.97 = 距離 TP1 3%內）
    requoteDeviationMax: 0.05,  // 重掛 entry 偏離容忍（預設 0.05 = 5%，超過棄單）
    requoteDiscount: 0.985,     // 重掛新 entry 折扣（預設 0.985 = 下修 1.5%）
    requoteStopFallback: 0.92,  // ml_stop_loss 缺失時回退係數（預設 0.92 = entry × 0.92）
    // 2026-04-18 #36
    riskPctBaseline: 0.01,
    riskPctBuy: 0.015,
    riskPctStrongBuy: 0.02,
    riskPctBuyConfThreshold: 0.70,
    riskPctStrongBuyConfThreshold: 0.80,
    downgradeRiskMultiplier: 0.5,
    // Round 2
    gapChaseBuffer: 0.995,
    fillSlippageTicks: 1,
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
    // 2026-04-18 #36
    leadingNegMomConfAdj: -0.03,
    improvingConfAdj: -0.02,
  },
  barrier: {
    upperMult: 3.0,
    lowerMult: 2.0,
    upperPctCap: 0.07,
    lowerPctCap: 0.03,
    maxDays: 20,
  },
  // ── Sprint 3 P0-4: Hybrid Ranking ─────────────────────────────────────────
  ranking: {
    enabled: true,          // default ON（解 0-signal 問題）
    topK: 3,
    alpha: 0.40,
    beta: 0.40,
    gamma: 0.20,
    screenerDenominator: 60,
    promoteMinConf: 0.60,
  },
  // ── 2026-04-07 NEW: Optuna #2 destination ─────────────────────────────────
  signal: {
    strongSignalScore: 0.72,
    buySignalScore: 0.52,
    holdSignalScore: 0.36,
    consensusThreshold: 0.60,
    // 2026-04-18 #36
    newsNegativeConfThreshold: 0.5,
    newsNegativeConfBoost: 0.05,
    newsNegativeConfCap: 0.75,
  },
  // ── 2026-04-07 NEW: Optuna #3 destination ─────────────────────────────────
  sltp: {
    slMultBase: 2.0,
    tpMultBase: 1.5,
    trailSwitch3pct: 0.03,
    trailSwitch8pct: 0.08,
    volThresholdLow: 0.015,
    volThresholdHigh: 0.03,
    // Sprint 5.1 Phase 7 Layer B defaults match pre-2026-04-09 ensemble.py hardcode
    slMultLow: 0.75,
    tpMultLow: 0.67,
    slMultHigh: 1.25,
    tpMultHigh: 1.33,
    // Sprint 5.1 Phase 7 Layer C default: 0.5% daily vol skip
    volSkipThreshold: 0.005,
    // 2026-04-18 #36
    tp2DistanceMultiplier: 2.0,
  },
  // ── 2026-04-07 NEW: L2 daily formula 內部係數 ─────────────────────────────
  L2_formula: {
    confidence_risk_mult: 0.15,
    confidence_perf_mult: 0.20,
    confidence_delta_clip_lo: -0.10,
    confidence_delta_clip_hi: 0.20,
    confidence_effective_clip_lo: 0.45,
    confidence_effective_clip_hi: 0.75,
    sltp_add_orange_sl: 0.3,
    sltp_add_orange_tp: 0.3,
    sltp_add_red_sl: 0.5,
    sltp_add_red_tp: 0.5,
    sltp_add_black_sl: 1.0,
    sltp_add_black_tp: 0.5,
    bandit_loss_thresh_high: 0.6,
    bandit_loss_thresh_med: 0.4,
    bandit_max_mult_high: 1.5,
    bandit_max_mult_med: 2.0,
    bandit_max_mult_low: 2.5,
    pf_quality_30d_weight: 0.7,
    pf_quality_90d_weight: 0.3,
    pf_quality_clip_lo: 0.3,
    pf_quality_clip_hi: 1.8,
    // Sprint 4-1
    night_drop_severe_pct: -1.5,
    night_drop_mild_pct: -0.8,
    night_drop_severe_adjust: 0.98,
    night_drop_mild_adjust: 0.99,
    medium_risk_scale: 0.5,
  },
  intraday: {
    rescoreEnabled: true,
    rescoreExitThreshold: 0.40,
    rescoreWarnThreshold: 0.55,
    rescoreDecaySensitivity: 5.0,
    rescoreCooldownMin: 60,
    maxRescoreExitsPerDay: 2,
  },
  momentum: {
    minVolumeRatio: 0.8,
    minRangePosition: 0.3,
    // Round 2
    tradingDayMinutes: 270,
    minutesFractionFloor: 0.1,
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
  // position 有 2 層 nested sub-object（kelly + swapWeights），需要深層 merge
  const mergedPosition = {
    ...d.position,
    ...partial.position,
    kelly: { ...d.position.kelly, ...(partial.position?.kelly ?? {}) },
    swapWeights: { ...d.position.swapWeights, ...(partial.position?.swapWeights ?? {}) },
  }
  return {
    fees: { ...d.fees, ...partial.fees },
    circuit: { ...d.circuit, ...partial.circuit },
    exit: { ...d.exit, ...partial.exit },
    position: mergedPosition,
    screener: { ...d.screener, ...partial.screener },
    rrg: { ...d.rrg, ...partial.rrg },
    barrier: { ...d.barrier, ...partial.barrier },
    ranking: { ...d.ranking, ...partial.ranking },
    // 2026-04-07 added:
    signal: { ...d.signal, ...partial.signal },
    sltp: { ...d.sltp, ...partial.sltp },
    L2_formula: { ...d.L2_formula, ...partial.L2_formula },
    intraday: { ...d.intraday, ...partial.intraday },
    momentum: { ...d.momentum, ...partial.momentum },
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

/** 寫入 KV（admin API 用）+ 清除 cache + auto snapshot (#28b T3.1)
 *
 * @param meta optional caller context { source, push_id }. When provided,
 *   a content-addressed snapshot is written to `trading:config:snapshot:<ISO>:<hash8>`
 *   and indexed at `trading:config:snapshot_index`. No-op writes (identical
 *   hash to previous config) skip snapshot to avoid noise. Snapshot failures
 *   are best-effort — main config write always succeeds (AWS CloudTrail pattern).
 */
export async function setTradingConfig(
  kv: KVNamespace,
  config: TradingConfig,
  meta?: { source?: string; push_id?: string },
): Promise<{ snapshotId: string | null; skipped: boolean }> {
  // 先 snapshot（讀 prev + hash compare）— main write 後面永遠跑
  let snapshotId: string | null = null
  let skipped = false
  try {
    const prevHash = _cached ? await hashConfig(_cached) : null
    const newHash = await hashConfig(config)
    if (prevHash === newHash) {
      skipped = true  // no-op write，不 pollute snapshot history
    } else {
      snapshotId = await writeSnapshot(kv, config, {
        source: meta?.source ?? 'unknown',
        push_id: meta?.push_id,
        prev_hash: prevHash,
        new_hash: newHash,
      })
    }
  } catch (e: any) {
    // Best-effort：snapshot 失敗不影響 main write（業界 audit fail-open 標準）
    console.warn(`[tradingConfig] snapshot failed (non-blocking): ${e?.message ?? e}`)
  }

  // Main write — 永遠跑，與 snapshot 成敗無關
  await kv.put(KV_KEY, JSON.stringify(config))
  _cached = config
  _cachedAt = Date.now()
  return { snapshotId, skipped }
}

/** 強制清除 in-memory cache（deploy 後或手動 reset） */
export function invalidateConfigCache(): void {
  _cached = null
  _cachedAt = 0
}

// ─── #28b T3.1: KV Snapshot Versioning (2026-04-20) ─────────────────────────
//
// Content-addressed snapshot chain for every trading:config PUT. Design:
//   - trading:config:snapshot:<ISO>:<hash8>  → full cfg + meta, TTL 90d
//   - trading:config:snapshot_index         → last 100 entries, no TTL
//
// Why 90-day TTL: AWS Config / GCP Audit Log default for operational audit
// (non-regulated). Metadata in index outlives snapshot body (AWS CloudTrail
// Lake pattern — metadata永久、body 90d)，長期仍可列出何時何 source 改過。
//
// Why content-addressed: Git blob / Docker layer pattern — same content
// same hash means no-op writes skip snapshot, preventing noise pollution.
//
// Why deterministic hash: RFC 8785 JSON Canonicalization Scheme — recursive
// key sort ensures nested-dict reorder doesn't change hash.

const SNAPSHOT_INDEX_KEY = 'trading:config:snapshot_index'
const SNAPSHOT_TTL_SEC = 90 * 86400    // 90 days
const SNAPSHOT_MAX_ENTRIES = 100       // last 100 in index

export interface ConfigSnapshotMeta {
  source: string           // 'barrier' | 'sltp' | 'manual' | 'l2_sensitivity' | 'unknown' 等
  push_id?: string         // caller-supplied correlation id (optuna run_id 等)
  prev_hash: string | null // chain link — 上一個 config hash
  new_hash: string         // 自己 content hash
}

export interface ConfigSnapshotEntry {
  id: string               // 'trading:config:snapshot:<ISO>:<hash8>'
  pushed_at: string        // ISO timestamp
  source: string
  push_id?: string
  hash: string             // hash8
  prev_hash: string | null
  bytes: number            // snapshot body size
}

export interface ConfigSnapshotRecord {
  config: TradingConfig
  meta: ConfigSnapshotMeta
  pushed_at: string
  bytes: number
}

/** Recursive canonical JSON (RFC 8785 style) — sorts keys at every level. */
function canonicalJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}

/** 8-hex-char (32-bit) content hash — safe for ≤1000 snapshots (birthday paradox ~1%). */
async function hashConfig(cfg: TradingConfig): Promise<string> {
  const canonical = canonicalJson(cfg)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const bytes = new Uint8Array(buf).slice(0, 4)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Write snapshot body + update index. Returns snapshot_id. */
async function writeSnapshot(
  kv: KVNamespace,
  config: TradingConfig,
  meta: ConfigSnapshotMeta,
): Promise<string> {
  const pushed_at = new Date().toISOString()
  const id = `trading:config:snapshot:${pushed_at}:${meta.new_hash}`
  const body = JSON.stringify({ config, meta, pushed_at } satisfies Omit<ConfigSnapshotRecord, 'bytes'>)
  const bytes = body.length

  // Body write — 90 day TTL
  await kv.put(id, body, { expirationTtl: SNAPSHOT_TTL_SEC })

  // Append index + truncate to last SNAPSHOT_MAX_ENTRIES
  const idxRaw = await kv.get(SNAPSHOT_INDEX_KEY, 'json') as ConfigSnapshotEntry[] | null
  const idx = Array.isArray(idxRaw) ? idxRaw : []
  const entry: ConfigSnapshotEntry = {
    id, pushed_at,
    source: meta.source,
    push_id: meta.push_id,
    hash: meta.new_hash,
    prev_hash: meta.prev_hash,
    bytes,
  }
  idx.unshift(entry)  // desc by pushed_at (newest first)
  const trimmed = idx.slice(0, SNAPSHOT_MAX_ENTRIES)
  await kv.put(SNAPSHOT_INDEX_KEY, JSON.stringify(trimmed))

  return id
}

/** List recent snapshots (most recent first). Used by T3.2 rollback UI. */
export async function listSnapshots(
  kv: KVNamespace,
  limit: number = 20,
): Promise<ConfigSnapshotEntry[]> {
  const idxRaw = await kv.get(SNAPSHOT_INDEX_KEY, 'json') as ConfigSnapshotEntry[] | null
  const idx = Array.isArray(idxRaw) ? idxRaw : []
  return idx.slice(0, Math.max(0, Math.min(limit, SNAPSHOT_MAX_ENTRIES)))
}

/** Fetch full snapshot body. Returns null if expired (TTL 90d) or never existed. */
export async function getSnapshot(
  kv: KVNamespace,
  id: string,
): Promise<ConfigSnapshotRecord | null> {
  const raw = await kv.get(id, 'json') as Omit<ConfigSnapshotRecord, 'bytes'> | null
  if (!raw) return null
  return { ...raw, bytes: JSON.stringify(raw).length }
}

// ─── #28b T3.3: Sandbox Namespace (2026-04-20) ──────────────────────────────
//
// Separate KV namespace for refactor-time / test pushes. Secure-by-default
// (Q5 locked): all optuna-push calls route here unless caller sets ?prod=1
// + X-Confirm-Prod: true header. Sandbox writes DO NOT trigger the T3.1
// prod snapshot chain — they accumulate in their own index until promoted.
//
// Design refs:
//   - Kubernetes namespace isolation (separate storage realm)
//   - MLflow stage None → Staging → Production (explicit promotion)
//   - Snowflake RBAC secure-by-default
//
// Promotion path: POST /api/admin/config/promote {sandbox_id} → reads
// sandbox body → calls setTradingConfig (triggers T3.1 prod snapshot).
// The sandbox entry itself stays intact for audit.

const SANDBOX_INDEX_KEY = 'trading:config:sandbox_index'
const SANDBOX_TTL_SEC = 30 * 86400     // 30 days (shorter than prod 90d — ephemeral staging)
const SANDBOX_MAX_ENTRIES = 50

export interface SandboxEntry {
  id: string
  pushed_at: string
  source: string
  hash: string
  bytes: number
  push_id?: string
  note?: string
}

export interface SandboxRecord {
  config: TradingConfig
  source: string
  pushed_at: string
  hash: string
  bytes: number
  push_id?: string
  note?: string
}

/** Write a sandbox entry. Never touches prod trading:config or its snapshot chain. */
export async function writeSandbox(
  kv: KVNamespace,
  source: string,
  config: TradingConfig,
  meta?: { push_id?: string; note?: string },
): Promise<string> {
  const pushed_at = new Date().toISOString()
  const hash = await hashConfig(config)
  const id = `trading:config:sandbox:${source}:${pushed_at}:${hash}`
  const body = JSON.stringify({
    config, source, pushed_at, hash,
    push_id: meta?.push_id,
    note: meta?.note,
  })
  const bytes = body.length

  // Body — 30d TTL (sandbox is ephemeral)
  await kv.put(id, body, { expirationTtl: SANDBOX_TTL_SEC })

  // Index — no TTL, truncate to last SANDBOX_MAX_ENTRIES
  const idxRaw = await kv.get(SANDBOX_INDEX_KEY, 'json') as SandboxEntry[] | null
  const idx = Array.isArray(idxRaw) ? idxRaw : []
  const entry: SandboxEntry = {
    id, pushed_at, source, hash, bytes,
    push_id: meta?.push_id,
    note: meta?.note,
  }
  idx.unshift(entry)
  const trimmed = idx.slice(0, SANDBOX_MAX_ENTRIES)
  await kv.put(SANDBOX_INDEX_KEY, JSON.stringify(trimmed))

  return id
}

/** List recent sandbox pushes (most recent first). Optional source filter. */
export async function listSandbox(
  kv: KVNamespace,
  limit: number = 20,
  sourceFilter?: string,
): Promise<SandboxEntry[]> {
  const idxRaw = await kv.get(SANDBOX_INDEX_KEY, 'json') as SandboxEntry[] | null
  const idx = Array.isArray(idxRaw) ? idxRaw : []
  const filtered = sourceFilter ? idx.filter(e => e.source === sourceFilter) : idx
  return filtered.slice(0, Math.max(0, Math.min(limit, SANDBOX_MAX_ENTRIES)))
}

/** Fetch a sandbox body. Returns null if expired (TTL 30d) or never existed. */
export async function getSandboxEntry(
  kv: KVNamespace,
  id: string,
): Promise<SandboxRecord | null> {
  if (!id.startsWith('trading:config:sandbox:')) return null
  const raw = await kv.get(id, 'json') as Omit<SandboxRecord, 'bytes'> | null
  if (!raw) return null
  return { ...raw, bytes: JSON.stringify(raw).length }
}

// ─── #28b T3.4: Challenger Slot (2026-04-20) ─────────────────────────────
//
// Single-slot challenger config living at `trading:config:challenger`.
// Paralleled by champion at `trading:config`. Weekly eval cron (T3.5)
// compares both via replay_period and auto-promotes or retires.
//
// Design refs:
//   - Plan A model_pool.json single-active/single-challenger pattern
//   - MLflow stage None → Staging → Production
//   - KV single-slot (vs GCS JSON pool): OK because we only track 1 challenger
//     at a time (Plan A tracks 10 models so needs a pool file)

const CHALLENGER_KEY = 'trading:config:challenger'

export interface ChallengerState {
  config: TradingConfig
  hash: string
  shadow_since: string        // ISO timestamp
  source: string              // 'sandbox:<id>' | 'manual' | 'auto'
  source_id?: string          // e.g. sandbox_id it came from
  note?: string
}

/** Read current challenger (null if no challenger active). */
export async function getChallenger(kv: KVNamespace): Promise<ChallengerState | null> {
  return (await kv.get(CHALLENGER_KEY, 'json') as ChallengerState | null) ?? null
}

/** Set challenger slot (overwrites any existing challenger). */
export async function setChallenger(
  kv: KVNamespace,
  config: TradingConfig,
  meta: { source: string; source_id?: string; note?: string },
): Promise<ChallengerState> {
  const hash = await hashConfig(config)
  const state: ChallengerState = {
    config,
    hash,
    shadow_since: new Date().toISOString(),
    source: meta.source,
    source_id: meta.source_id,
    note: meta.note,
  }
  await kv.put(CHALLENGER_KEY, JSON.stringify(state))
  return state
}

/** Retire (clear) challenger slot. */
export async function retireChallenger(kv: KVNamespace): Promise<void> {
  await kv.delete(CHALLENGER_KEY)
}

/** Expose content hash helper for external callers (T3.5 eval). */
export async function computeConfigHash(config: TradingConfig): Promise<string> {
  return hashConfig(config)
}

/** Promote a sandbox entry to prod. Triggers T3.1 snapshot chain. */
export async function promoteSandbox(
  kv: KVNamespace,
  sandboxId: string,
  meta?: { push_id?: string; reason?: string },
): Promise<{ snapshotId: string | null; skipped: boolean; promotedFrom: string } | null> {
  const entry = await getSandboxEntry(kv, sandboxId)
  if (!entry) return null
  const r = await setTradingConfig(kv, entry.config, {
    source: `promote:${entry.source}`,
    push_id: meta?.push_id ?? sandboxId,
  })
  return { ...r, promotedFrom: sandboxId }
}

/** Restore a snapshot by writing its config back to KV as a new forward-commit
 *  (Git `git revert` pattern — not destructive reset). Triggers a new snapshot
 *  in the chain tagged source='restore' with meta linking to the restored id.
 *  Returns the new snapshot id (forward commit) or null if snapshot missing.
 */
export async function restoreSnapshot(
  kv: KVNamespace,
  snapshotId: string,
  meta?: { push_id?: string; restore_reason?: string },
): Promise<{ snapshotId: string | null; skipped: boolean; restoredFrom: string } | null> {
  const snap = await getSnapshot(kv, snapshotId)
  if (!snap) return null
  const r = await setTradingConfig(kv, snap.config, {
    source: 'restore',
    push_id: meta?.push_id ?? snapshotId,
  })
  return { ...r, restoredFrom: snapshotId }
}

// ─── C4: Config Validation ──────────────────────────────────────────────────

export function validateTradingConfig(config: TradingConfig): string[] {
  const errors: string[] = []
  if (config.exit.hardStopPct > 0 || config.exit.hardStopPct < -0.30)
    errors.push('hardStopPct must be between -0.30 and 0')
  if (config.circuit.maxPositionPct < 0.01 || config.circuit.maxPositionPct > 0.50)
    errors.push('maxPositionPct must be 0.01-0.50')
  if (config.position.dailyBuyLimit < 0)
    errors.push('dailyBuyLimit must be >= 0')
  if (config.barrier.upperMult < 0.5 || config.barrier.upperMult > 10)
    errors.push('barrier.upperMult must be 0.5-10')
  if (config.barrier.lowerMult < 0.5 || config.barrier.lowerMult > 10)
    errors.push('barrier.lowerMult must be 0.5-10')
  // Cross-field: drawdownScaleStart must be < drawdownHalt (otherwise MDD formula
  // produces NaN/Infinity due to negative denominator)
  const cc = config.circuit
  if (cc.drawdownScaleStart != null && cc.drawdownHalt != null) {
    if (cc.drawdownScaleStart >= cc.drawdownHalt)
      errors.push(`drawdownScaleStart (${cc.drawdownScaleStart}) must be < drawdownHalt (${cc.drawdownHalt})`)
  }
  // mddMultFloor sanity (FinLab formula: 0 = full halt, 1 = no scaling)
  if (cc.mddMultFloor != null && (cc.mddMultFloor < 0.05 || cc.mddMultFloor > 0.95))
    errors.push('mddMultFloor must be 0.05-0.95')
  // Confidence clip: lo must be < hi
  const l2 = (config as any).L2_formula
  if (l2?.confidence_effective_clip_lo != null && l2?.confidence_effective_clip_hi != null) {
    if (l2.confidence_effective_clip_lo >= l2.confidence_effective_clip_hi)
      errors.push(`confidence clip lo (${l2.confidence_effective_clip_lo}) must be < hi (${l2.confidence_effective_clip_hi})`)
  }
  return errors
}
