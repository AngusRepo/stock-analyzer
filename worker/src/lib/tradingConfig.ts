/**
 * tradingConfig.ts — 統一交易參數管理
 *
 * 28 個可 runtime 調整的交易參數，存於 KV `trading:config`。
 * 讀取一次、快取 300s、fallback default。
 */

import { readCurrentLegacyRegimeLabel } from './marketRegimeState'

// ─── Type ────────────────────────────────────────────────────────────────────

export type AlphaFrameworkRegime = 'bull' | 'bear' | 'volatile' | 'sideways'
export type AlphaFrameworkBucket =
  | 'trend_following'
  | 'mean_reversion'
  | 'breakout_vol_expansion'
  | 'defensive_accumulation'

export type AlphaFrameworkBucketWeights = Record<AlphaFrameworkBucket, number>

export interface AlphaFrameworkConfig {
  riskOverlay: {
    volatilityExpansionRatio: number
    volatilityExpansionMin3d: number
    extremeVolThreshold: number
    highVolThreshold: number
    liquidityLowVolume: number
    liquidityThinVolume: number
    skipSizingCap: number
    volatilityExpansionPenalty: number
    highVolPenalty: number
    extremeVolPenalty: number
    thinLiquidityPenalty: number
    lowLiquidityPenalty: number
    extendedAboveFairValuePenalty: number
    fragileStructurePenalty: number
    constructiveReturnMin: number
    fragileReturnMax: number
    extremeVolSkipConfidenceMin: number
    fairValueRangeLookback: number
    fairValueAtrMultiplier: number
    fairValueMinPct: number
  }
  allocation: {
    engine: string
    controller: string
    buySignalCount: number
    slateSize: number
    scoreRoundDecimals: number
    weights: Record<AlphaFrameworkRegime, AlphaFrameworkBucketWeights>
  }
  classification: {
    breakoutNearHighRatio: number
    breakoutReturnMin: number
    breakoutVolumeRatioMin: number
    breakoutForecastMin: number
    trendReturnMin: number
    trendForecastMin: number
    meanReversionRsiMax: number
    meanReversionReturnMax: number
    meanReversionForecastMin: number
  }
  regimeBucketMultipliers: Record<AlphaFrameworkRegime, AlphaFrameworkBucketWeights>
  scoring: {
    bucketBonus: AlphaFrameworkBucketWeights
    regimeWeightImpact: number
    overlayPenaltyImpact: number
    scoreMin: number
    scoreMax: number
    confidenceWeightImpact: number
    confidencePenaltyImpact: number
    confidenceMin: number
    confidenceMax: number
  }
  executionOverlay: {
    sizingMin: number
    sizingMax: number
    highVolSizingMultiplier: number
    extremeVolSizingMultiplier: number
    thinLiquiditySizingMultiplier: number
    lowLiquiditySizingMultiplier: number
    highVolStopMultiplier: number
    extremeVolStopMultiplier: number
    meanReversionStopMultiplier: number
    bullTrendTargetMultiplier: number
    nonBullTrendTargetMultiplier: number
    defensiveRiskTargetMultiplier: number
  }
  quality: {
    outcomeLimit: number
    minSamples: number
    minRegimeSamples: number
    minBucketSamples: number
    posteriorFullConfidenceSamples: number
    posteriorWeightImpactBps: number
    minBucketWeightBps: number
    returnPctPerRBps: number
    directionCorrectFallbackRBps: number
  }
}

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
    // ── #28b T2.3/#30 Step 9c (2026-04-21): Regime-conditional exit cascade ──
    // When true, checkExitConditions uses dynamicExitPriority.getExitOrder(regime)
    // to reorder the exit rule cascade (hardStop / atrTrail / tp1 / tp2 / timeStop)
    // based on the current HMM regime label. Default false = fixed cascade order
    // (backwards-compat, same behavior since Sprint 3). Flip via `wrangler kv put`
    // after 2026-04-27 shadow-log review (logRegimeShadow printed hypothetical
    // orders since 4/20 for A/B comparison). Actual sltp multiplier overlay
    // (resolveSltpForRegime) is ALREADY live since T2.3 — this flag only
    // controls cascade ORDER.
    dynamicExitPriorityEnabled: boolean  // 預設 false，4/27 後 Wei KV 翻
  }
  position: {
    dailyBuyLimit: number        // 每日自動買入上限 NT$
    manualDailyLimit: number     // 每日手動買入上限 NT$
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
    maxQuoteAgeMs: number        // broker quote 最大可接受延遲（預設 60000ms）
    maxEntryChasePct: number     // 強勢股盤中追價上限（預設 0.006 = 0.6%）
    strongBreakoutMaxEntryChasePct: number // 量價確認突破追價上限（預設 0.018 = 1.8%）
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
    maxEntryPremiumPct: number             // pending buy entry 不可高於最新收盤價的比例（預設 0.01）
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
    emergingMaxCandidates: number // 興櫃研究觀察候選上限（不進 pending buys，預設 24）
    candidatePoolSize?: number   // Screener enrichment top pool（預設由 screenerPolicy 解析）
    coarseMlQueueSize?: number   // 送入 ml-controller Layer 2 coarse ML gate 的上市櫃 queue
    mlShortlistSize?: number     // Layer 3 core family ML shortlist（預設由 screenerPolicy 解析）
    emergingResearchSize?: number // 興櫃研究 shortlist（預設由 screenerPolicy 解析）
    scoreCalibrationEnabled?: boolean
    scoreCalibrationMinSize?: number
    scoreCalibrationPercentileWeight?: number
    scoreCalibrationZScoreWeight?: number
    maxPerIndustry: number       // 同官方產業上限（預設 5）
    correlationThreshold: number // 報酬率去重門檻（預設 0.8）
    correlationWindow: number    // 去重計算天數（預設 60）
    chipScoreTiers: number[]     // 籌碼分級分數（預設 [32,24,16,8,2]）
    chipIntensityThresholds: number[] // 籌碼強度門檻（預設 [0.80,0.45,0.20,0.05,-0.05]）
    consecBuyBonusTiers: number[]    // 連續買超加分（預設 [3,1]，對應 >=5天, >=3天）
    consecBuyDayThresholds: number[] // 連續買超天數門檻（預設 [5,3]）
    rsiScoreTiers: number[]          // RSI 分級分數（預設 [10,6,4,2,2]）
    macdNegativeFactor: number       // MACD 負值比較因子（預設 0.5）
    keltnerMultiplier: number        // 肯特納通道 ATR 倍數（預設 1.5）
    natrThreshold: number            // NATR 低波動門檻（預設 3）
    excessReturnRange: number[]      // 超額報酬 normalize 範圍（預設 [-0.03, 0.05]）
    volRatioRange: number[]          // 量比 normalize 範圍（預設 [0.7, 2.5]）
    // #16 Sector leader correlation bonus (2026-04-21, dannyquant_tw 啟發)
    sectorLeaderBonusPoints: number  // 加分點數（預設 5）
    sectorLeaderCorrThreshold: number // avg 60d corr 觸發門檻（預設 0.7）
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
    // Deprecated compatibility only. Score V2 screener ranking uses
    // canonical chipFlow + technicalStructure, not this legacy denominator.
    screenerDenominator: number
    promoteMinConf: number       // promoted row 的 confidence 保底（預設 0.60，對齊 buyConfThreshold）
  }
  // ── #B Option 1 (2026-04-21): ensemble_v2 thresholds + Top-K override ─────
  // Fixes "bot 4 天沒掛單" — regression-on-rank ensemble_v2 predicted values
  // cluster [0.43, 0.58] under realistic R² 0.02-0.05, never hits hardcoded
  // 0.70 BUY threshold → signal always HOLD → no pending buys.
  //
  // Strategy: keep absolute thresholds (for when real strong signal emerges)
  // AND add Top-K override — sort predictions by avg_rank desc, force top K
  // to signal="BUY" regardless of absolute threshold (industry-standard
  // top-K selection for compressed-distribution regression outputs).
  //
  // Threshold schema mirrors ml-service/app/ensemble.rank_to_signal kwargs so
  // Optuna search can tune both paths uniformly in future (#28b Tier 1).
  ensemble_v2: {
    strongBuyThreshold: number       // 絕對 STRONG_BUY 門檻（預設 0.85）
    buyThreshold: number             // 絕對 BUY 門檻（預設 0.70）
    sellThreshold: number            // 絕對 SELL 門檻（預設 0.30）
    strongSellThreshold: number      // 絕對 STRONG_SELL 門檻（預設 0.15）
    topKOverrideEnabled: boolean     // Top-K 補救開關（預設 false，legacy rollback only）
    allowLegacyTopKOverride: boolean // rollback-only guard; sparse tangent is production owner
    topKCount: number                // 強制 BUY 的 top-K 數（預設 3，對齊 ranking.topK）
    topKConfidenceOverride: number   // Top-K 強制 BUY 時的 confidence（預設 0.72）
  }
  // ── 2026-04-07 added: Optuna #2 Signal 月搜結果 destination ────────────────
  // 之前寫進 ml:adaptive_params 是錯的（adaptive_params 應該只裝 daily delta）
  signal: {
    strongSignalScore: number    // STRONG_BUY 門檻（預設 0.72）
    buySignalScore: number       // BUY 門檻（預設 0.52） — Optuna 月搜的 baseline
    holdSignalScore: number      // HOLD 門檻（預設 0.36）
    consensusThreshold: number   // 共識門檻（預設 0.60）
    modelVoteBullishThreshold: number // per-model rank score 看漲門檻 fallback（會再套 regime adjustment）
    modelVoteBearishThreshold: number // per-model rank score 看跌門檻 fallback（會再套 regime adjustment）
    modelVoteRegimeAdjustments: Record<AlphaFrameworkRegime, number> // bull 可放寬，bear/volatile/sideways 可拉寬觀望帶
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
  // ── #28b T2.2 (2026-04-21): Per-regime sltp overlay ─────────────────────
  // Optional — when empty (default), paper.ts uses flat sltp.* above. When
  // present, active market_regime_state label picks the matching overlay;
  // legacy ml:regime remains only as a migration mirror/fallback.
  // fields in overlay override matching sltp.* fields; unset fields fall back
  // to flat sltp.* (partial override pattern, Kubernetes ConfigMap style).
  //
  // Four HMM regime labels (aligned with ml-service/app/regime.py):
  //   bull_market / volatile / sideways / bear_market
  // Produced by /optuna/per_regime robust search → sandbox → challenger → prod.
  sltp_per_regime?: {
    bull_market?:  Partial<TradingConfig['sltp']>
    volatile?:     Partial<TradingConfig['sltp']>
    sideways?:     Partial<TradingConfig['sltp']>
    bear_market?:  Partial<TradingConfig['sltp']>
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
  // ── #28b T1.3/T1.4 (2026-04-21): Risk event trigger thresholds ────────────
  // Used by daily-report cron (lib/riskTriggers.ts) to decide when to enqueue
  // Optuna re-tune requests into pending_optuna_queue. KV-driven so Wei can
  // tune as the strategy stabilises (industry systematic L/S always uses
  // config-driven thresholds, not hardcode — see mistake.md M33 context).
  risk: {
    sharpe_rolling_threshold: number     // rolling 30d sharpe < this → T1.3 trigger (預設 0.5，業界 systematic L/S 常用 0.3-0.5 區間)
    dd_spike_threshold: number           // 單日 drawdown > this → T1.4 trigger (預設 0.08 = 8%)
  }
  // ── Sprint 5.2+: Intraday Re-score 安控 ───────────────────────────────────
  // 盤中 call ml-controller /intraday/rescore，對持倉 confidence 衰減。
  // 這層只產生 WARN / EXIT_SIGNAL evidence；實際賣出 owner 固定為
  // paperExitPolicy 的 TP1 / TP2 / Stop / Trailing / EOD cascade。
  // See memory/project_instance_scaling_brainstorm.md Part A
  intraday: {
    rescoreEnabled: boolean              // feature flag（預設 true）
    rescoreExitThreshold: number         // confidence 低於此值 → EXIT_SIGNAL（預設 0.40，不直接賣出）
    rescoreWarnThreshold: number         // confidence 低於此值 → WARN（預設 0.55）
    rescoreDecaySensitivity: number      // 每 1% 反向價格變動的 confidence 衰減倍數（預設 5.0）
    rescoreCooldownMin: number           // 同一檔 re-score 觸發後 N 分鐘內不再觸發（預設 60）
    maxRescoreExitsPerDay: number        // 每日最多 re-score 觸發出場次數（預設 2）
  }
  // ── F4: Intraday Momentum Confirmation（買入二次確認）─────────────────────
  momentum: {
    minVolumeRatio: number               // 最低 volume ratio vs 20d avg（預設 0.8）
    minRangePosition: number             // 最低 day range position（預設 0.3 = 30%）
    strongBreakoutVolumeRatio: number    // 強勢突破最低 volume ratio（預設 1.5）
    strongBreakoutRangePosition: number  // 強勢突破最低 day range position（預設 0.7）
    // 2026-04-18 #36 Round 2
    tradingDayMinutes: number            // 台股交易時段分鐘數（預設 270 = 9:00-13:30）
    minutesFractionFloor: number         // minutesSinceOpen/total 下限（預設 0.1 防早盤分母太小）
    avgVolumeLookbackDays: number        // 量能基準最近 N 日（預設 20）
    intradayVolumeLotSize: number        // Shioaji total_volume 單位換算股數（預設 1000）
  }
  alphaFramework: AlphaFrameworkConfig
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
    dynamicExitPriorityEnabled: false,  // #16 Step 9c prep — 4/27 Wei KV 翻
  },
  position: {
    dailyBuyLimit: 500_000,
    manualDailyLimit: 500_000,
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
    maxQuoteAgeMs: 60_000,
    maxEntryChasePct: 0.006,
    strongBreakoutMaxEntryChasePct: 0.018,
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
    maxEntryPremiumPct: 0.01,
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
    emergingMaxCandidates: 24,
    candidatePoolSize: 200,
    coarseMlQueueSize: 80,
    mlShortlistSize: 35,
    emergingResearchSize: 24,
    scoreCalibrationEnabled: true,
    scoreCalibrationMinSize: 30,
    scoreCalibrationPercentileWeight: 0.65,
    scoreCalibrationZScoreWeight: 0.35,
    maxPerIndustry: 5,
    correlationThreshold: 0.8,
    correlationWindow: 60,
    chipScoreTiers: [32, 24, 16, 8, 2],
    chipIntensityThresholds: [0.80, 0.45, 0.20, 0.05, -0.05],
    consecBuyBonusTiers: [3, 1],
    consecBuyDayThresholds: [5, 3],
    rsiScoreTiers: [10, 6, 4, 2, 2],
    macdNegativeFactor: 0.5,
    keltnerMultiplier: 1.5,
    natrThreshold: 3,
    excessReturnRange: [-0.03, 0.05],
    volRatioRange: [0.7, 2.5],
    // #16 Sector leader correlation bonus defaults
    sectorLeaderBonusPoints: 5,
    sectorLeaderCorrThreshold: 0.7,
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
    // Deprecated compatibility only; kept for older KV/config shapes.
    screenerDenominator: 60,
    promoteMinConf: 0.60,
  },
  // ── #B Option 1 (2026-04-21): ensemble_v2 thresholds + Top-K override ─────
  ensemble_v2: {
    strongBuyThreshold: 0.85,
    buyThreshold: 0.70,
    sellThreshold: 0.30,
    strongSellThreshold: 0.15,
    topKOverrideEnabled: false,
    allowLegacyTopKOverride: false,
    topKCount: 3,
    topKConfidenceOverride: 0.72,
  },
  // ── 2026-04-07 NEW: Optuna #2 destination ─────────────────────────────────
  signal: {
    strongSignalScore: 0.72,
    buySignalScore: 0.52,
    holdSignalScore: 0.36,
    consensusThreshold: 0.60,
    modelVoteBullishThreshold: 0.55,
    modelVoteBearishThreshold: 0.45,
    modelVoteRegimeAdjustments: {
      bull: -0.02,
      bear: 0.03,
      volatile: 0.03,
      sideways: 0.02,
    },
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
  // ── #28b T2.2 (2026-04-21): Per-regime overlay default empty ─────────────
  // Empty = fall back to flat sltp.* for all regimes (backward-compatible).
  // Populated by /optuna/per_regime → sandbox → challenger → prod flow.
  sltp_per_regime: {},
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
  // #28b T1.3/T1.4 defaults
  risk: {
    sharpe_rolling_threshold: 0.5,
    dd_spike_threshold: 0.08,
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
    strongBreakoutVolumeRatio: 1.5,
    strongBreakoutRangePosition: 0.7,
    // Round 2
    tradingDayMinutes: 270,
    minutesFractionFloor: 0.1,
    avgVolumeLookbackDays: 20,
    intradayVolumeLotSize: 1000,
  },
  alphaFramework: {
    riskOverlay: {
      volatilityExpansionRatio: 1.8,
      volatilityExpansionMin3d: 0.025,
      extremeVolThreshold: 0.07,
      highVolThreshold: 0.035,
      liquidityLowVolume: 50_000,
      liquidityThinVolume: 250_000,
      skipSizingCap: 0.35,
      volatilityExpansionPenalty: 1.5,
      highVolPenalty: 3.0,
      extremeVolPenalty: 8.0,
      thinLiquidityPenalty: 1.5,
      lowLiquidityPenalty: 5.0,
      extendedAboveFairValuePenalty: 1.0,
      fragileStructurePenalty: 2.0,
      constructiveReturnMin: 0.015,
      fragileReturnMax: -0.04,
      extremeVolSkipConfidenceMin: 0.70,
      fairValueRangeLookback: 10,
      fairValueAtrMultiplier: 0.75,
      fairValueMinPct: 0.01,
    },
    allocation: {
      engine: 'sparse_tangent_inverse_risk',
      controller: 'OnlinePortfolioBandit',
      buySignalCount: 3,
      slateSize: 10,
      scoreRoundDecimals: 1,
      weights: {
        bull: {
          trend_following: 0.35,
          breakout_vol_expansion: 0.35,
          mean_reversion: 0.15,
          defensive_accumulation: 0.15,
        },
        bear: {
          defensive_accumulation: 0.40,
          mean_reversion: 0.25,
          trend_following: 0.20,
          breakout_vol_expansion: 0.15,
        },
        volatile: {
          defensive_accumulation: 0.45,
          breakout_vol_expansion: 0.20,
          trend_following: 0.20,
          mean_reversion: 0.15,
        },
        sideways: {
          mean_reversion: 0.35,
          defensive_accumulation: 0.25,
          breakout_vol_expansion: 0.20,
          trend_following: 0.20,
        },
      },
    },
    classification: {
      breakoutNearHighRatio: 0.995,
      breakoutReturnMin: 0.03,
      breakoutVolumeRatioMin: 1.15,
      breakoutForecastMin: 0.03,
      trendReturnMin: 0.015,
      trendForecastMin: 0.0,
      meanReversionRsiMax: 45.0,
      meanReversionReturnMax: 0.0,
      meanReversionForecastMin: 0.0,
    },
    regimeBucketMultipliers: {
      bull: {
        trend_following: 1.15,
        breakout_vol_expansion: 1.12,
        mean_reversion: 0.95,
        defensive_accumulation: 1.00,
      },
      bear: {
        trend_following: 0.78,
        breakout_vol_expansion: 0.82,
        mean_reversion: 0.90,
        defensive_accumulation: 1.08,
      },
      volatile: {
        trend_following: 0.86,
        breakout_vol_expansion: 0.92,
        mean_reversion: 0.84,
        defensive_accumulation: 1.10,
      },
      sideways: {
        trend_following: 0.92,
        breakout_vol_expansion: 0.96,
        mean_reversion: 1.12,
        defensive_accumulation: 1.00,
      },
    },
    scoring: {
      bucketBonus: {
        trend_following: 2.0,
        mean_reversion: 1.0,
        breakout_vol_expansion: 3.0,
        defensive_accumulation: 0.5,
      },
      regimeWeightImpact: 10.0,
      overlayPenaltyImpact: 1.0,
      scoreMin: -12.0,
      scoreMax: 8.0,
      confidenceWeightImpact: 0.25,
      confidencePenaltyImpact: 0.01,
      confidenceMin: 0.75,
      confidenceMax: 1.08,
    },
    executionOverlay: {
      sizingMin: 0.25,
      sizingMax: 1.25,
      highVolSizingMultiplier: 0.80,
      extremeVolSizingMultiplier: 0.55,
      thinLiquiditySizingMultiplier: 0.85,
      lowLiquiditySizingMultiplier: 0.45,
      highVolStopMultiplier: 1.18,
      extremeVolStopMultiplier: 1.35,
      meanReversionStopMultiplier: 0.95,
      bullTrendTargetMultiplier: 1.12,
      nonBullTrendTargetMultiplier: 1.05,
      defensiveRiskTargetMultiplier: 0.92,
    },
    quality: {
      outcomeLimit: 1000,
      minSamples: 30,
      minRegimeSamples: 6,
      minBucketSamples: 8,
      posteriorFullConfidenceSamples: 20,
      posteriorWeightImpactBps: 1200,
      minBucketWeightBps: 200,
      returnPctPerRBps: 200,
      directionCorrectFallbackRBps: 2500,
    },
  },
}

// ─── KV 讀取（300s cache）──────────────────────────────────────────────────

const KV_KEY = 'trading:config'
const CACHE_TTL_MS = 300_000  // 5 min in-memory cache

let _cached: TradingConfig | null = null
let _cachedAt = 0

export function mergeAlphaFrameworkConfig(partial?: Partial<AlphaFrameworkConfig> | any): AlphaFrameworkConfig {
  const d = DEFAULT_TRADING_CONFIG.alphaFramework
  const raw = partial ?? {}
  const rawOverlay = raw.riskOverlay ?? raw.risk_overlay ?? {}
  const rawAllocation = raw.allocation ?? {}
  const rawClassification = raw.classification ?? {}
  const rawRegimeMultipliers = raw.regimeBucketMultipliers ?? raw.regime_bucket_multipliers ?? {}
  const rawScoring = raw.scoring ?? {}
  const rawBucketBonus = rawScoring.bucketBonus ?? rawScoring.bucket_bonus ?? {}
  const rawExecution = raw.executionOverlay ?? raw.execution_overlay ?? {}
  const rawQuality = raw.quality ?? {}
  const rawWeights = rawAllocation.weights ?? {}
  const mergeWeights = (regime: AlphaFrameworkRegime): AlphaFrameworkBucketWeights => ({
    ...d.allocation.weights[regime],
    ...(rawWeights[regime] ?? {}),
  })
  const mergeRegimeMultipliers = (regime: AlphaFrameworkRegime): AlphaFrameworkBucketWeights => ({
    ...d.regimeBucketMultipliers[regime],
    ...(rawRegimeMultipliers[regime] ?? {}),
  })
  const mergeBucketBonus = (): AlphaFrameworkBucketWeights => ({
    ...d.scoring.bucketBonus,
    ...rawBucketBonus,
  })
  return {
    riskOverlay: {
      ...d.riskOverlay,
      volatilityExpansionRatio: rawOverlay.volatilityExpansionRatio ?? rawOverlay.volatility_expansion_ratio ?? d.riskOverlay.volatilityExpansionRatio,
      volatilityExpansionMin3d: rawOverlay.volatilityExpansionMin3d ?? rawOverlay.volatility_expansion_min_3d ?? d.riskOverlay.volatilityExpansionMin3d,
      extremeVolThreshold: rawOverlay.extremeVolThreshold ?? rawOverlay.extreme_vol_threshold ?? d.riskOverlay.extremeVolThreshold,
      highVolThreshold: rawOverlay.highVolThreshold ?? rawOverlay.high_vol_threshold ?? d.riskOverlay.highVolThreshold,
      liquidityLowVolume: rawOverlay.liquidityLowVolume ?? rawOverlay.liquidity_low_volume ?? d.riskOverlay.liquidityLowVolume,
      liquidityThinVolume: rawOverlay.liquidityThinVolume ?? rawOverlay.liquidity_thin_volume ?? d.riskOverlay.liquidityThinVolume,
      skipSizingCap: rawOverlay.skipSizingCap ?? rawOverlay.skip_sizing_cap ?? d.riskOverlay.skipSizingCap,
      volatilityExpansionPenalty: rawOverlay.volatilityExpansionPenalty ?? rawOverlay.volatility_expansion_penalty ?? d.riskOverlay.volatilityExpansionPenalty,
      highVolPenalty: rawOverlay.highVolPenalty ?? rawOverlay.high_vol_penalty ?? d.riskOverlay.highVolPenalty,
      extremeVolPenalty: rawOverlay.extremeVolPenalty ?? rawOverlay.extreme_vol_penalty ?? d.riskOverlay.extremeVolPenalty,
      thinLiquidityPenalty: rawOverlay.thinLiquidityPenalty ?? rawOverlay.thin_liquidity_penalty ?? d.riskOverlay.thinLiquidityPenalty,
      lowLiquidityPenalty: rawOverlay.lowLiquidityPenalty ?? rawOverlay.low_liquidity_penalty ?? d.riskOverlay.lowLiquidityPenalty,
      extendedAboveFairValuePenalty: rawOverlay.extendedAboveFairValuePenalty ?? rawOverlay.extended_above_fair_value_penalty ?? d.riskOverlay.extendedAboveFairValuePenalty,
      fragileStructurePenalty: rawOverlay.fragileStructurePenalty ?? rawOverlay.fragile_structure_penalty ?? d.riskOverlay.fragileStructurePenalty,
      constructiveReturnMin: rawOverlay.constructiveReturnMin ?? rawOverlay.constructive_return_min ?? d.riskOverlay.constructiveReturnMin,
      fragileReturnMax: rawOverlay.fragileReturnMax ?? rawOverlay.fragile_return_max ?? d.riskOverlay.fragileReturnMax,
      extremeVolSkipConfidenceMin: rawOverlay.extremeVolSkipConfidenceMin ?? rawOverlay.extreme_vol_skip_confidence_min ?? d.riskOverlay.extremeVolSkipConfidenceMin,
      fairValueRangeLookback: rawOverlay.fairValueRangeLookback ?? rawOverlay.fair_value_range_lookback ?? d.riskOverlay.fairValueRangeLookback,
      fairValueAtrMultiplier: rawOverlay.fairValueAtrMultiplier ?? rawOverlay.fair_value_atr_multiplier ?? d.riskOverlay.fairValueAtrMultiplier,
      fairValueMinPct: rawOverlay.fairValueMinPct ?? rawOverlay.fair_value_min_pct ?? d.riskOverlay.fairValueMinPct,
    },
    allocation: {
      ...d.allocation,
      ...rawAllocation,
      engine: rawAllocation.engine ?? rawAllocation.method ?? d.allocation.engine,
      controller: rawAllocation.controller ?? d.allocation.controller,
      buySignalCount: rawAllocation.buySignalCount ?? rawAllocation.buy_signal_count ?? d.allocation.buySignalCount,
      slateSize: rawAllocation.slateSize ?? rawAllocation.slate_size ?? d.allocation.slateSize,
      scoreRoundDecimals: rawAllocation.scoreRoundDecimals ?? rawAllocation.score_round_decimals ?? d.allocation.scoreRoundDecimals,
      weights: {
        bull: mergeWeights('bull'),
        bear: mergeWeights('bear'),
        volatile: mergeWeights('volatile'),
        sideways: mergeWeights('sideways'),
      },
    },
    classification: {
      ...d.classification,
      breakoutNearHighRatio: rawClassification.breakoutNearHighRatio ?? rawClassification.breakout_near_high_ratio ?? d.classification.breakoutNearHighRatio,
      breakoutReturnMin: rawClassification.breakoutReturnMin ?? rawClassification.breakout_return_min ?? d.classification.breakoutReturnMin,
      breakoutVolumeRatioMin: rawClassification.breakoutVolumeRatioMin ?? rawClassification.breakout_volume_ratio_min ?? d.classification.breakoutVolumeRatioMin,
      breakoutForecastMin: rawClassification.breakoutForecastMin ?? rawClassification.breakout_forecast_min ?? d.classification.breakoutForecastMin,
      trendReturnMin: rawClassification.trendReturnMin ?? rawClassification.trend_return_min ?? d.classification.trendReturnMin,
      trendForecastMin: rawClassification.trendForecastMin ?? rawClassification.trend_forecast_min ?? d.classification.trendForecastMin,
      meanReversionRsiMax: rawClassification.meanReversionRsiMax ?? rawClassification.mean_reversion_rsi_max ?? d.classification.meanReversionRsiMax,
      meanReversionReturnMax: rawClassification.meanReversionReturnMax ?? rawClassification.mean_reversion_return_max ?? d.classification.meanReversionReturnMax,
      meanReversionForecastMin: rawClassification.meanReversionForecastMin ?? rawClassification.mean_reversion_forecast_min ?? d.classification.meanReversionForecastMin,
    },
    regimeBucketMultipliers: {
      bull: mergeRegimeMultipliers('bull'),
      bear: mergeRegimeMultipliers('bear'),
      volatile: mergeRegimeMultipliers('volatile'),
      sideways: mergeRegimeMultipliers('sideways'),
    },
    scoring: {
      ...d.scoring,
      bucketBonus: mergeBucketBonus(),
      regimeWeightImpact: rawScoring.regimeWeightImpact ?? rawScoring.regime_weight_impact ?? d.scoring.regimeWeightImpact,
      overlayPenaltyImpact: rawScoring.overlayPenaltyImpact ?? rawScoring.overlay_penalty_impact ?? d.scoring.overlayPenaltyImpact,
      scoreMin: rawScoring.scoreMin ?? rawScoring.score_min ?? d.scoring.scoreMin,
      scoreMax: rawScoring.scoreMax ?? rawScoring.score_max ?? d.scoring.scoreMax,
      confidenceWeightImpact: rawScoring.confidenceWeightImpact ?? rawScoring.confidence_weight_impact ?? d.scoring.confidenceWeightImpact,
      confidencePenaltyImpact: rawScoring.confidencePenaltyImpact ?? rawScoring.confidence_penalty_impact ?? d.scoring.confidencePenaltyImpact,
      confidenceMin: rawScoring.confidenceMin ?? rawScoring.confidence_min ?? d.scoring.confidenceMin,
      confidenceMax: rawScoring.confidenceMax ?? rawScoring.confidence_max ?? d.scoring.confidenceMax,
    },
    executionOverlay: {
      ...d.executionOverlay,
      sizingMin: rawExecution.sizingMin ?? rawExecution.sizing_min ?? d.executionOverlay.sizingMin,
      sizingMax: rawExecution.sizingMax ?? rawExecution.sizing_max ?? d.executionOverlay.sizingMax,
      highVolSizingMultiplier: rawExecution.highVolSizingMultiplier ?? rawExecution.high_vol_sizing_multiplier ?? d.executionOverlay.highVolSizingMultiplier,
      extremeVolSizingMultiplier: rawExecution.extremeVolSizingMultiplier ?? rawExecution.extreme_vol_sizing_multiplier ?? d.executionOverlay.extremeVolSizingMultiplier,
      thinLiquiditySizingMultiplier: rawExecution.thinLiquiditySizingMultiplier ?? rawExecution.thin_liquidity_sizing_multiplier ?? d.executionOverlay.thinLiquiditySizingMultiplier,
      lowLiquiditySizingMultiplier: rawExecution.lowLiquiditySizingMultiplier ?? rawExecution.low_liquidity_sizing_multiplier ?? d.executionOverlay.lowLiquiditySizingMultiplier,
      highVolStopMultiplier: rawExecution.highVolStopMultiplier ?? rawExecution.high_vol_stop_multiplier ?? d.executionOverlay.highVolStopMultiplier,
      extremeVolStopMultiplier: rawExecution.extremeVolStopMultiplier ?? rawExecution.extreme_vol_stop_multiplier ?? d.executionOverlay.extremeVolStopMultiplier,
      meanReversionStopMultiplier: rawExecution.meanReversionStopMultiplier ?? rawExecution.mean_reversion_stop_multiplier ?? d.executionOverlay.meanReversionStopMultiplier,
      bullTrendTargetMultiplier: rawExecution.bullTrendTargetMultiplier ?? rawExecution.bull_trend_target_multiplier ?? d.executionOverlay.bullTrendTargetMultiplier,
      nonBullTrendTargetMultiplier: rawExecution.nonBullTrendTargetMultiplier ?? rawExecution.non_bull_trend_target_multiplier ?? d.executionOverlay.nonBullTrendTargetMultiplier,
      defensiveRiskTargetMultiplier: rawExecution.defensiveRiskTargetMultiplier ?? rawExecution.defensive_risk_target_multiplier ?? d.executionOverlay.defensiveRiskTargetMultiplier,
    },
    quality: {
      ...d.quality,
      outcomeLimit: rawQuality.outcomeLimit ?? rawQuality.outcome_limit ?? d.quality.outcomeLimit,
      minSamples: rawQuality.minSamples ?? rawQuality.min_samples ?? d.quality.minSamples,
      minRegimeSamples: rawQuality.minRegimeSamples ?? rawQuality.min_regime_samples ?? d.quality.minRegimeSamples,
      minBucketSamples: rawQuality.minBucketSamples ?? rawQuality.min_bucket_samples ?? d.quality.minBucketSamples,
      posteriorFullConfidenceSamples: rawQuality.posteriorFullConfidenceSamples ?? rawQuality.posterior_full_confidence_samples ?? d.quality.posteriorFullConfidenceSamples,
      posteriorWeightImpactBps: rawQuality.posteriorWeightImpactBps ?? rawQuality.posterior_weight_impact_bps ?? d.quality.posteriorWeightImpactBps,
      minBucketWeightBps: rawQuality.minBucketWeightBps ?? rawQuality.min_bucket_weight_bps ?? d.quality.minBucketWeightBps,
      returnPctPerRBps: rawQuality.returnPctPerRBps ?? rawQuality.return_pct_per_r_bps ?? d.quality.returnPctPerRBps,
      directionCorrectFallbackRBps: rawQuality.directionCorrectFallbackRBps ?? rawQuality.direction_correct_fallback_r_bps ?? d.quality.directionCorrectFallbackRBps,
    },
  }
}

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
    // #B Option 1 (2026-04-21):
    ensemble_v2: { ...d.ensemble_v2, ...partial.ensemble_v2 },
    // 2026-04-07 added:
    signal: { ...d.signal, ...partial.signal },
    sltp: { ...d.sltp, ...partial.sltp },
    sltp_per_regime: partial.sltp_per_regime ?? d.sltp_per_regime ?? {},
    L2_formula: { ...d.L2_formula, ...partial.L2_formula },
    risk: { ...d.risk, ...partial.risk },
    intraday: { ...d.intraday, ...partial.intraday },
    momentum: { ...d.momentum, ...partial.momentum },
    alphaFramework: mergeAlphaFrameworkConfig(partial.alphaFramework ?? partial.alpha_framework),
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
  metadata?: Record<string, unknown>
}

export interface SandboxRecord {
  config: TradingConfig
  source: string
  pushed_at: string
  hash: string
  bytes: number
  push_id?: string
  note?: string
  metadata?: Record<string, unknown>
}

/** Write a sandbox entry. Never touches prod trading:config or its snapshot chain. */
export async function writeSandbox(
  kv: KVNamespace,
  source: string,
  config: TradingConfig,
  meta?: { push_id?: string; note?: string; metadata?: Record<string, unknown> },
): Promise<string> {
  const pushed_at = new Date().toISOString()
  const hash = await hashConfig(config)
  const id = `trading:config:sandbox:${source}:${pushed_at}:${hash}`
  const body = JSON.stringify({
    config, source, pushed_at, hash,
    push_id: meta?.push_id,
    note: meta?.note,
    metadata: meta?.metadata,
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
    metadata: meta?.metadata,
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
//     at a time (Plan A tracks alpha predictors plus separate overlay metadata)

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

// ─── #28b T2.2 Regime-conditional sltp lookup ───────────────────────────────
//
// Resolves the effective sltp block for a given regime label by overlaying
// sltp_per_regime[label] onto flat sltp (partial override pattern).
// Unknown / null label → returns flat sltp (backward-compat).

export type RegimeLabel = 'bull_market' | 'volatile' | 'sideways' | 'bear_market'

/** Normalize regime label variants ('bull', 'bull_market', 'BULL') to canonical form. */
function _normalizeRegimeLabel(label: string): RegimeLabel | null {
  const lower = label.toLowerCase().trim()
  if (lower.startsWith('bull')) return 'bull_market'
  if (lower.startsWith('bear')) return 'bear_market'
  if (lower.startsWith('volatile')) return 'volatile'
  if (lower.startsWith('sideway')) return 'sideways'
  return null
}

export function resolveSltpForRegime(
  config: TradingConfig,
  regime: RegimeLabel | string | null | undefined,
): TradingConfig['sltp'] {
  const flat = config.sltp
  if (!regime) return flat
  const canonical = _normalizeRegimeLabel(String(regime))
  if (!canonical) return flat
  const perRegime = config.sltp_per_regime ?? {}
  const overlay = perRegime[canonical]
  if (!overlay) return flat
  // Shallow merge: overlay fields win, missing fields fall back to flat
  return { ...flat, ...overlay }
}

/** Fetch current market_regime_state label, with legacy ml:regime fallback. */
export async function getCurrentRegime(kv: KVNamespace): Promise<RegimeLabel | null> {
  const raw = await readCurrentLegacyRegimeLabel(kv)
  if (!raw) return null
  const label = raw.trim() as RegimeLabel
  const valid: Set<string> = new Set(['bull_market', 'volatile', 'sideways', 'bear_market'])
  return valid.has(label) ? label : null
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
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)
  if (config.exit.hardStopPct > 0 || config.exit.hardStopPct < -0.30)
    errors.push('hardStopPct must be between -0.30 and 0')
  if (config.circuit.maxPositionPct < 0.01 || config.circuit.maxPositionPct > 0.50)
    errors.push('maxPositionPct must be 0.01-0.50')
  if (config.position.dailyBuyLimit < 0)
    errors.push('dailyBuyLimit must be >= 0')
  if (!isFiniteNumber(config.position.maxQuoteAgeMs) || config.position.maxQuoteAgeMs < 10_000 || config.position.maxQuoteAgeMs > 180_000)
    errors.push('position.maxQuoteAgeMs must be 10000-180000')
  if (!isFiniteNumber(config.position.maxEntryChasePct) || config.position.maxEntryChasePct < 0 || config.position.maxEntryChasePct > 0.03)
    errors.push('position.maxEntryChasePct must be 0-0.03')
  if (!isFiniteNumber(config.position.strongBreakoutMaxEntryChasePct) || config.position.strongBreakoutMaxEntryChasePct < 0 || config.position.strongBreakoutMaxEntryChasePct > 0.03)
    errors.push('position.strongBreakoutMaxEntryChasePct must be 0-0.03')
  if (config.barrier.upperMult < 0.5 || config.barrier.upperMult > 10)
    errors.push('barrier.upperMult must be 0.5-10')
  if (config.barrier.lowerMult < 0.5 || config.barrier.lowerMult > 10)
    errors.push('barrier.lowerMult must be 0.5-10')
  if (!isFiniteNumber(config.momentum.minVolumeRatio) || config.momentum.minVolumeRatio < 0 || config.momentum.minVolumeRatio > 5)
    errors.push('momentum.minVolumeRatio must be 0-5')
  if (!isFiniteNumber(config.momentum.minRangePosition) || config.momentum.minRangePosition < 0 || config.momentum.minRangePosition > 1)
    errors.push('momentum.minRangePosition must be 0-1')
  if (!isFiniteNumber(config.momentum.strongBreakoutVolumeRatio) || config.momentum.strongBreakoutVolumeRatio < 0 || config.momentum.strongBreakoutVolumeRatio > 5)
    errors.push('momentum.strongBreakoutVolumeRatio must be 0-5')
  if (!isFiniteNumber(config.momentum.strongBreakoutRangePosition) || config.momentum.strongBreakoutRangePosition < 0 || config.momentum.strongBreakoutRangePosition > 1)
    errors.push('momentum.strongBreakoutRangePosition must be 0-1')
  if (!Number.isInteger(config.momentum.avgVolumeLookbackDays) || config.momentum.avgVolumeLookbackDays < 1 || config.momentum.avgVolumeLookbackDays > 120)
    errors.push('momentum.avgVolumeLookbackDays must be an integer between 1 and 120')
  if (!isFiniteNumber(config.momentum.intradayVolumeLotSize) || config.momentum.intradayVolumeLotSize <= 0 || config.momentum.intradayVolumeLotSize > 10_000)
    errors.push('momentum.intradayVolumeLotSize must be >0 and <=10000')
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
  const alpha = config.alphaFramework
  const overlay = alpha?.riskOverlay
  const allocation = alpha?.allocation
  const classification = alpha?.classification
  const regimeBucketMultipliers = alpha?.regimeBucketMultipliers
  const scoring = alpha?.scoring
  const executionOverlay = alpha?.executionOverlay
  const quality = alpha?.quality
  if (!overlay) {
    errors.push('alphaFramework.riskOverlay is required')
  } else {
    if (!isFiniteNumber(overlay.volatilityExpansionRatio) || overlay.volatilityExpansionRatio < 0.5 || overlay.volatilityExpansionRatio > 5)
      errors.push('alphaFramework.riskOverlay.volatilityExpansionRatio must be 0.5-5')
    if (!isFiniteNumber(overlay.volatilityExpansionMin3d) || overlay.volatilityExpansionMin3d < 0 || overlay.volatilityExpansionMin3d > 0.30)
      errors.push('alphaFramework.riskOverlay.volatilityExpansionMin3d must be 0-0.30')
    if (!isFiniteNumber(overlay.highVolThreshold) || overlay.highVolThreshold <= 0 || overlay.highVolThreshold > 0.30)
      errors.push('alphaFramework.riskOverlay.highVolThreshold must be >0 and <=0.30')
    if (!isFiniteNumber(overlay.extremeVolThreshold) || overlay.extremeVolThreshold <= overlay.highVolThreshold || overlay.extremeVolThreshold > 0.50)
      errors.push('alphaFramework.riskOverlay.extremeVolThreshold must be > highVolThreshold and <=0.50')
    if (!isFiniteNumber(overlay.liquidityLowVolume) || overlay.liquidityLowVolume < 0)
      errors.push('alphaFramework.riskOverlay.liquidityLowVolume must be >= 0')
    if (!isFiniteNumber(overlay.liquidityThinVolume) || overlay.liquidityThinVolume < overlay.liquidityLowVolume)
      errors.push('alphaFramework.riskOverlay.liquidityThinVolume must be >= liquidityLowVolume')
    if (!isFiniteNumber(overlay.skipSizingCap) || overlay.skipSizingCap < 0.05 || overlay.skipSizingCap > 1)
      errors.push('alphaFramework.riskOverlay.skipSizingCap must be 0.05-1')
    const penaltyKeys: (keyof AlphaFrameworkConfig['riskOverlay'])[] = [
      'volatilityExpansionPenalty',
      'highVolPenalty',
      'extremeVolPenalty',
      'thinLiquidityPenalty',
      'lowLiquidityPenalty',
      'extendedAboveFairValuePenalty',
      'fragileStructurePenalty',
    ]
    for (const key of penaltyKeys) {
      const value = overlay[key]
      if (!isFiniteNumber(value) || value < 0 || value > 50)
        errors.push(`alphaFramework.riskOverlay.${key} must be 0-50`)
    }
    if (!isFiniteNumber(overlay.constructiveReturnMin) || overlay.constructiveReturnMin < -0.50 || overlay.constructiveReturnMin > 0.50)
      errors.push('alphaFramework.riskOverlay.constructiveReturnMin must be -0.50-0.50')
    if (!isFiniteNumber(overlay.fragileReturnMax) || overlay.fragileReturnMax < -0.50 || overlay.fragileReturnMax > 0.50)
      errors.push('alphaFramework.riskOverlay.fragileReturnMax must be -0.50-0.50')
    if (!isFiniteNumber(overlay.extremeVolSkipConfidenceMin) || overlay.extremeVolSkipConfidenceMin < 0 || overlay.extremeVolSkipConfidenceMin > 1)
      errors.push('alphaFramework.riskOverlay.extremeVolSkipConfidenceMin must be 0-1')
    if (!Number.isInteger(overlay.fairValueRangeLookback) || overlay.fairValueRangeLookback < 1 || overlay.fairValueRangeLookback > 60)
      errors.push('alphaFramework.riskOverlay.fairValueRangeLookback must be an integer between 1 and 60')
    if (!isFiniteNumber(overlay.fairValueAtrMultiplier) || overlay.fairValueAtrMultiplier < 0 || overlay.fairValueAtrMultiplier > 10)
      errors.push('alphaFramework.riskOverlay.fairValueAtrMultiplier must be 0-10')
    if (!isFiniteNumber(overlay.fairValueMinPct) || overlay.fairValueMinPct < 0 || overlay.fairValueMinPct > 0.50)
      errors.push('alphaFramework.riskOverlay.fairValueMinPct must be 0-0.50')
  }
  if (!allocation) {
    errors.push('alphaFramework.allocation is required')
  } else {
    if (!Number.isInteger(allocation.slateSize) || allocation.slateSize < 1 || allocation.slateSize > 30)
      errors.push('alphaFramework.allocation.slateSize must be an integer between 1 and 30')
    if (allocation.engine !== 'sparse_tangent_inverse_risk')
      errors.push('alphaFramework.allocation.engine must be sparse_tangent_inverse_risk')
    if (!Number.isInteger(allocation.buySignalCount) || allocation.buySignalCount < 1 || allocation.buySignalCount > 30)
      errors.push('alphaFramework.allocation.buySignalCount must be an integer between 1 and 30')
    if (!Number.isInteger(allocation.scoreRoundDecimals) || allocation.scoreRoundDecimals < 0 || allocation.scoreRoundDecimals > 6)
      errors.push('alphaFramework.allocation.scoreRoundDecimals must be an integer between 0 and 6')
    const regimes: AlphaFrameworkRegime[] = ['bull', 'bear', 'volatile', 'sideways']
    const buckets: AlphaFrameworkBucket[] = [
      'trend_following',
      'mean_reversion',
      'breakout_vol_expansion',
      'defensive_accumulation',
    ]
    for (const regime of regimes) {
      const weights = allocation.weights?.[regime]
      if (!weights) {
        errors.push(`alphaFramework.allocation.weights.${regime} is required`)
        continue
      }
      let sum = 0
      for (const bucket of buckets) {
        const value = weights[bucket]
        if (!isFiniteNumber(value) || value < 0)
          errors.push(`alphaFramework.allocation.weights.${regime}.${bucket} must be a non-negative number`)
        else
          sum += value
      }
      if (sum <= 0)
        errors.push(`alphaFramework.allocation.weights.${regime} must have positive total weight`)
    }
  }
  if (!classification) {
    errors.push('alphaFramework.classification is required')
  } else {
    if (!isFiniteNumber(classification.breakoutNearHighRatio) || classification.breakoutNearHighRatio < 0.80 || classification.breakoutNearHighRatio > 1)
      errors.push('alphaFramework.classification.breakoutNearHighRatio must be 0.80-1')
    if (!isFiniteNumber(classification.breakoutReturnMin) || classification.breakoutReturnMin < -0.50 || classification.breakoutReturnMin > 0.50)
      errors.push('alphaFramework.classification.breakoutReturnMin must be -0.50-0.50')
    if (!isFiniteNumber(classification.breakoutVolumeRatioMin) || classification.breakoutVolumeRatioMin <= 0 || classification.breakoutVolumeRatioMin > 10)
      errors.push('alphaFramework.classification.breakoutVolumeRatioMin must be >0 and <=10')
    if (!isFiniteNumber(classification.breakoutForecastMin) || classification.breakoutForecastMin < -0.50 || classification.breakoutForecastMin > 0.50)
      errors.push('alphaFramework.classification.breakoutForecastMin must be -0.50-0.50')
    if (!isFiniteNumber(classification.trendReturnMin) || classification.trendReturnMin < -0.50 || classification.trendReturnMin > 0.50)
      errors.push('alphaFramework.classification.trendReturnMin must be -0.50-0.50')
    if (!isFiniteNumber(classification.trendForecastMin) || classification.trendForecastMin < -0.50 || classification.trendForecastMin > 0.50)
      errors.push('alphaFramework.classification.trendForecastMin must be -0.50-0.50')
    if (!isFiniteNumber(classification.meanReversionRsiMax) || classification.meanReversionRsiMax < 1 || classification.meanReversionRsiMax > 99)
      errors.push('alphaFramework.classification.meanReversionRsiMax must be 1-99')
    if (!isFiniteNumber(classification.meanReversionReturnMax) || classification.meanReversionReturnMax < -0.50 || classification.meanReversionReturnMax > 0.50)
      errors.push('alphaFramework.classification.meanReversionReturnMax must be -0.50-0.50')
    if (!isFiniteNumber(classification.meanReversionForecastMin) || classification.meanReversionForecastMin < -0.50 || classification.meanReversionForecastMin > 0.50)
      errors.push('alphaFramework.classification.meanReversionForecastMin must be -0.50-0.50')
  }
  if (!regimeBucketMultipliers) {
    errors.push('alphaFramework.regimeBucketMultipliers is required')
  } else {
    const regimes: AlphaFrameworkRegime[] = ['bull', 'bear', 'volatile', 'sideways']
    const buckets: AlphaFrameworkBucket[] = [
      'trend_following',
      'mean_reversion',
      'breakout_vol_expansion',
      'defensive_accumulation',
    ]
    for (const regime of regimes) {
      const multipliers = regimeBucketMultipliers[regime]
      if (!multipliers) {
        errors.push(`alphaFramework.regimeBucketMultipliers.${regime} is required`)
        continue
      }
      for (const bucket of buckets) {
        const value = multipliers[bucket]
        if (!isFiniteNumber(value) || value < 0 || value > 3)
          errors.push(`alphaFramework.regimeBucketMultipliers.${regime}.${bucket} must be 0-3`)
      }
    }
  }
  if (!scoring) {
    errors.push('alphaFramework.scoring is required')
  } else {
    const buckets: AlphaFrameworkBucket[] = [
      'trend_following',
      'mean_reversion',
      'breakout_vol_expansion',
      'defensive_accumulation',
    ]
    for (const bucket of buckets) {
      const value = scoring.bucketBonus?.[bucket]
      if (!isFiniteNumber(value) || value < 0 || value > 20)
        errors.push(`alphaFramework.scoring.bucketBonus.${bucket} must be 0-20`)
    }
    if (!isFiniteNumber(scoring.regimeWeightImpact) || scoring.regimeWeightImpact < 0 || scoring.regimeWeightImpact > 50)
      errors.push('alphaFramework.scoring.regimeWeightImpact must be 0-50')
    if (!isFiniteNumber(scoring.overlayPenaltyImpact) || scoring.overlayPenaltyImpact < 0 || scoring.overlayPenaltyImpact > 5)
      errors.push('alphaFramework.scoring.overlayPenaltyImpact must be 0-5')
    if (!isFiniteNumber(scoring.scoreMin) || !isFiniteNumber(scoring.scoreMax) || scoring.scoreMin > scoring.scoreMax)
      errors.push('alphaFramework.scoring.scoreMin must be <= scoreMax')
    if (!isFiniteNumber(scoring.confidenceMin) || !isFiniteNumber(scoring.confidenceMax) || scoring.confidenceMin > scoring.confidenceMax)
      errors.push('alphaFramework.scoring.confidenceMin must be <= confidenceMax')
  }
  if (!executionOverlay) {
    errors.push('alphaFramework.executionOverlay is required')
  } else {
    if (!isFiniteNumber(executionOverlay.sizingMin) || !isFiniteNumber(executionOverlay.sizingMax) || executionOverlay.sizingMin < 0 || executionOverlay.sizingMin > executionOverlay.sizingMax || executionOverlay.sizingMax > 3)
      errors.push('alphaFramework.executionOverlay.sizingMin/sizingMax must be 0-3 and min<=max')
    const multiplierKeys: (keyof AlphaFrameworkConfig['executionOverlay'])[] = [
      'highVolSizingMultiplier',
      'extremeVolSizingMultiplier',
      'thinLiquiditySizingMultiplier',
      'lowLiquiditySizingMultiplier',
      'highVolStopMultiplier',
      'extremeVolStopMultiplier',
      'meanReversionStopMultiplier',
      'bullTrendTargetMultiplier',
      'nonBullTrendTargetMultiplier',
      'defensiveRiskTargetMultiplier',
    ]
    for (const key of multiplierKeys) {
      const value = executionOverlay[key]
      if (!isFiniteNumber(value) || value <= 0 || value > 5)
        errors.push(`alphaFramework.executionOverlay.${key} must be >0 and <=5`)
    }
  }
  if (!quality) {
    errors.push('alphaFramework.quality is required')
  } else {
    if (!Number.isInteger(quality.outcomeLimit) || quality.outcomeLimit < 100 || quality.outcomeLimit > 5000)
      errors.push('alphaFramework.quality.outcomeLimit must be an integer between 100 and 5000')
    if (!Number.isInteger(quality.minSamples) || quality.minSamples < 1 || quality.minSamples > 1000)
      errors.push('alphaFramework.quality.minSamples must be an integer between 1 and 1000')
    if (!Number.isInteger(quality.minRegimeSamples) || quality.minRegimeSamples < 1 || quality.minRegimeSamples > 500)
      errors.push('alphaFramework.quality.minRegimeSamples must be an integer between 1 and 500')
    if (!Number.isInteger(quality.minBucketSamples) || quality.minBucketSamples < 1 || quality.minBucketSamples > 500)
      errors.push('alphaFramework.quality.minBucketSamples must be an integer between 1 and 500')
    if (!Number.isInteger(quality.posteriorFullConfidenceSamples) || quality.posteriorFullConfidenceSamples < 1 || quality.posteriorFullConfidenceSamples > 1000)
      errors.push('alphaFramework.quality.posteriorFullConfidenceSamples must be an integer between 1 and 1000')
    if (!Number.isInteger(quality.posteriorWeightImpactBps) || quality.posteriorWeightImpactBps < 0 || quality.posteriorWeightImpactBps > 10000)
      errors.push('alphaFramework.quality.posteriorWeightImpactBps must be an integer between 0 and 10000')
    if (!Number.isInteger(quality.minBucketWeightBps) || quality.minBucketWeightBps < 0 || quality.minBucketWeightBps > 2500)
      errors.push('alphaFramework.quality.minBucketWeightBps must be an integer between 0 and 2500')
    if (!Number.isInteger(quality.returnPctPerRBps) || quality.returnPctPerRBps < 1 || quality.returnPctPerRBps > 10000)
      errors.push('alphaFramework.quality.returnPctPerRBps must be an integer between 1 and 10000')
    if (!Number.isInteger(quality.directionCorrectFallbackRBps) || quality.directionCorrectFallbackRBps < 0 || quality.directionCorrectFallbackRBps > 10000)
      errors.push('alphaFramework.quality.directionCorrectFallbackRBps must be an integer between 0 and 10000')
    if (
      Number.isInteger(quality.minSamples) &&
      Number.isInteger(quality.minBucketSamples) &&
      quality.minBucketSamples > quality.minSamples
    )
      errors.push('alphaFramework.quality.minBucketSamples must be <= minSamples')
    if (
      Number.isInteger(quality.minSamples) &&
      Number.isInteger(quality.minRegimeSamples) &&
      quality.minRegimeSamples > quality.minSamples
    )
      errors.push('alphaFramework.quality.minRegimeSamples must be <= minSamples')
  }
  return errors
}
