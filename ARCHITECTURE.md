# StockVision v12 — Complete System Architecture

> 自動化台股量化交易系統。Bottom-up 多因子選股 + RRG 產業輪動 + 10 模型 ensemble + LinUCB + ARF + Conformal Prediction + Opus 多空辯論 + MDD 動態部位管理。

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER (17:30 TW)                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │TWSE      │  │TPEX      │  │D1 stock_ │  │Yahoo     │  │PTT/Anue  │  │
│  │STOCK_DAY │  │OTC_QUOTES│  │prices    │  │(Queue)   │  │Sentiment │  │
│  │+T86 Chips│  │+3itrade  │  │(歷史補充)│  │歷史回填  │  │即時爬蟲  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       └──────────────┴──────────────┴──────────────┴──────────────┘      │
│                              ↓ D1 Database (38 tables)                  │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│              SCREENER v2 (17:40 TW) — Bottom-up 多因子                  │
│                                                                         │
│  Step 1: Universe hard filter (~800-1000 檔)                           │
│     close 15-2000 + 20d avg vol > 300K + turnover > 500 萬             │
│     D1 stock_prices 補充 API 不足天數                                    │
│                                                                         │
│  Step 2: 多因子評分 (0-90)                                              │
│     籌碼(0-40): 法人佔日均成交% + 連買天數                               │
│     技術(0-30): RSI + MACD + 均線 + 肯特納 + NATR低波動                 │
│     動能(0-20): excess return + 量能比 + 價格意圖因子 + RSI鈍化          │
│                                                                         │
│  Step 3: RRG 產業輪動 (官方38產業, Regime-adaptive window)              │
│     RS-Ratio Z-score + EMA momentum → Leading/Improving/Weakening/Lag  │
│                                                                         │
│  Step 4: 情緒面 + F-Score + 外資天數佔比                                │
│  Step 4c: 趨勢品質 (ADX + intent adaptive 百分位 + 流動性分級)          │
│  Step 5: 同產業≤5 + Pearson 60d 去重 + top 25                          │
│                                                                         │
│  Output: daily_recommendations (chip+tech+price) + stocks is_active     │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                     QUEUE + ENRICH (17:40~ parallel)                    │
│  Yahoo 歷史回填 → 技術指標 → 新聞情緒 → 三源 Buzz (PTT+News+Anue)    │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                  ML ENSEMBLE (15:30 TW) — Cloud Run                    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  LAYER 1: 10 Base Models (Independent Predictions)              │   │
│  │                                                                   │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │   │
│  │  │ Kalman  │ │ DLinear │ │ Markov  │ │PatchTST │ │ Chronos │  │   │
│  │  │ Filter  │ │         │ │Switching│ │(Transf) │ │(Found.) │  │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘  │   │
│  │  ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐  │   │
│  │  │ XGBoost │ │CatBoost │ │ExtraTr. │ │LightGBM │ │  FT-    │  │   │
│  │  │         │ │ +7 lags │ │  (RF)   │ │  Rank   │ │Transf.  │  │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘  │   │
│  │       └──────┬─────┴─────┬─────┴─────┬─────┴─────┬─────┘      │   │
│  │              ↓           ↓           ↓           ↓             │   │
│  └──────────────┼───────────┼───────────┼───────────┼─────────────┘   │
│                 ↓           ↓           ↓           ↓                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  LAYER 2: Ensemble Aggregation (Dynamic 5-Layer Weighting)      │   │
│  │                                                                   │   │
│  │  weight = accuracy × confidence × quality_mult                  │   │
│  │          × regime_mult(HMM) × bandit_mult(LinUCB)              │   │
│  │                                                                   │   │
│  │  Consensus ≥ 60% + Confidence ≥ threshold → Signal              │   │
│  │  GARCH-based dynamic SL/TP (not static ATR)                     │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                              ↓                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ★ META-LEARNER 1: LinUCB Contextual Bandit                    │   │
│  │                                                                   │   │
│  │  Purpose: Context-aware model routing — "哪個模型在當前市場     │   │
│  │           狀態下最準" 而非直接預測股價                           │   │
│  │                                                                   │   │
│  │  Context Vector (4D):                                            │   │
│  │    [HMM regime, GARCH volatility, market_risk_score, bias=1]    │   │
│  │                                                                   │   │
│  │  Arms: 10 base models                                           │   │
│  │  Algorithm: Disjoint LinUCB (α=0.3, decay 0.5→0.1)             │   │
│  │  Output: Per-model weight multiplier (0.3x ~ 2.5x)             │   │
│  │  Reward: T+1 direction accuracy (delayed, no feedback loop)     │   │
│  │  Persistence: GCS (.npz) + ThreadPoolExecutor warm-up           │   │
│  │                                                                   │   │
│  │  Key: 不是第 11 個預測模型，是 model-of-models 路由器            │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                              ↓                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ★ META-LEARNER 2: ARF Online Aggregator                       │   │
│  │                                                                   │   │
│  │  Purpose: 學習 "哪種 10-model 輸出組合 → 真的會漲"              │   │
│  │                                                                   │   │
│  │  Feature Vector (33D):                                           │   │
│  │    [10 directions, 10 confidences, 10 accuracies,               │   │
│  │     HMM regime, GARCH vol, market_risk]                         │   │
│  │                                                                   │   │
│  │  Algorithm: River AdaptiveRandomForest + ADWIN drift detection  │   │
│  │  Learning: Incremental learn_one() on T+1 verified outcomes     │   │
│  │  Output: P(up) soft correction (±5% max, conservative)          │   │
│  │  Warm-up: 50+ samples before activation                         │   │
│  │  Persistence: GCS (pickle)                                      │   │
│  │                                                                   │   │
│  │  Key: 捕捉 base models 的共線性模式 + concept drift 自動重建    │   │
│  └──────────────────────────┬──────────────────────────────────────┘   │
│                              ↓                                         │
│  Final Output: signal, confidence, forecast_pct, entry/SL/TP1/TP2    │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│               ADAPTIVE PARAMETER ENGINE (16:05 TW)                     │
│                                                                         │
│  Inputs: 30D/90D model accuracy, 5D win/loss, RRG distribution        │
│                                                                         │
│  Outputs (applied T+1):                                                │
│  ├─ confidence_threshold: 0.55~0.75 (risk↑ → bar↑)                   │
│  ├─ pf_quality_mult: per-model 0.3~1.8 (underperform → downweight)   │
│  ├─ sl_tp_override: null/+0.3x/+0.5x/+1.0x (by risk level)          │
│  └─ bandit_max_mult + force_explore (drawdown → explore new models)   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                    DEBATE TRADER (07:15 TW)                            │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │  Round 1 — BULL 🐂                                           │      │
│  │  ML signal + company profile (客戶/供應商/產品) + 美股先行    │      │
│  ├──────────────────────────────────────────────────────────────┤      │
│  │  Round 2 — BEAR 🐻                                           │      │
│  │  價值面挑戰 (P/E vs growth) + 技術疲勞 (RSI/量能背離)        │      │
│  │  + 宏觀風險 (Fed/供應鏈/地緣)                                │      │
│  ├──────────────────────────────────────────────────────────────┤      │
│  │  Round 3 — JUDGE ⚖️                                          │      │
│  │  Conviction Score 0-100                                      │      │
│  │  ≥70 → APPROVE (全倉)                                       │      │
│  │  40~69 → DOWNGRADE (半倉)                                   │      │
│  │  <40 → REJECT (不進場)                                      │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                                                                         │
│  LLM Stack (cost-optimized):                                           │
│  Local Tunnel Opus (free) → Workers AI Llama 3.3 70B (free)           │
│  → Anthropic Haiku (paid, last resort)                                 │
│                                                                         │
│  KV Cache: paper:debate:{symbol}:{date} — 同天不重跑 (M9 教訓)        │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                 PAPER TRADING + EXIT ENGINE                             │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │  7-LAYER EXIT SYSTEM                                          │     │
│  │                                                                 │     │
│  │  L1: Stop Loss (GARCH dynamic, not static)                    │     │
│  │  L2: Take Profit 1 — 50% 出場                                 │     │
│  │  L3: Take Profit 2 — 25% 出場 (trailing)                      │     │
│  │  L4: Max Hold Days (20D timeout → force exit)                  │     │
│  │  L5: Trailing Stop (ATR-based, lock profits)                   │     │
│  │  L6: Emergency MDD (-10% portfolio → all exit)                 │     │
│  │  L7: EOD 13:25 — 到期/觸價強制平倉                            │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │  5-LAYER CIRCUIT BREAKER                                      │     │
│  │                                                                 │     │
│  │  CB1: Market Risk ≥ red → 全面暫停新進場                       │     │
│  │  CB2: MDD ≥ 15% portfolio → HALT                              │     │
│  │  CB3: 大盤跌幅 > 3% 單日 → 當日暫停                           │     │
│  │  CB4: VIX > 35 → 只出不進                                     │     │
│  │  CB5: 連續 ≥3 筆虧損 → HALT (SafetyMode)                     │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  Position Sizing: Risk-based (信心度分級) + 零股支援                   │
│  違約交割防線: 每日 20 萬額度 + 6 層防呆                              │
│  當沖防呆: isDayTradeAllowed() + 時間範圍檢查                         │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                 T+1 ONLINE LEARNING LOOP                               │
│                                                                         │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐           │
│  │ Paper Orders  │────→│ Verify T+1   │────→│ Calc Reward  │           │
│  │ (yesterday)   │     │ actual close │     │ direction    │           │
│  └──────────────┘     └──────┬───────┘     └──────┬───────┘           │
│                              │                      │                   │
│                    ┌─────────┴──────────┐  ┌───────┴────────┐         │
│                    │ LinUCB.update()    │  │ ARF.learn_one()│         │
│                    │ per-arm reward     │  │ incremental    │         │
│                    │ (0=wrong, 1=right) │  │ + ADWIN drift  │         │
│                    └────────────────────┘  └────────────────┘         │
│                                                                         │
│  ★ No feedback loop: T+1 delay prevents overfitting                    │
│  ★ Model accuracy refreshes daily (no stale backtests)                 │
│  ★ Adaptive params computed T+1, applied T+2                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Market Risk Engine (7 因子)

```
┌─────────────────────────────────────────────────────┐
│              Market Risk Score (0~100)               │
│                                                       │
│  VIX (Yahoo)              ████████████████  max 35   │
│  TWII Volatility (20D)    ████████████      max 20   │
│  TWII Bias (MA20)         ██████████        max 15   │
│  Foreign Chips (5D sum)   ████████████      max 20   │
│  Margin Ratio             ██████            max 10   │
│  ADL Trend (5D slope)     ████              max  8   │
│  Margin Maintenance       ████              max  8   │
│  Bull Alignment %         ████              max  8   │
│                                                       │
│  Risk Levels:                                        │
│  🟢 green  (0~25)  → Normal                         │
│  🟡 yellow (26~45) → Caution                        │
│  🟠 orange (46~65) → Reduce position                │
│  🔴 red    (66~85) → Slash position                 │
│  ⚫ black  (86+)   → Cash hold                      │
└─────────────────────────────────────────────────────┘
```

---

## Screener Pipeline (T0 → T5)

```
全市場 ~1,800 stocks
    │
    ├─ T0: Basic Exclusion (處置股 + 注意股 + 停牌 + 興櫃流動性)
    │   → ~1,400
    │
    ├─ T1: Sector Heat + Momentum Clusters
    │   7 concepts: 均線黃金叉 / 外資買超 / 量價齊揚 / 動量破頂
    │              融資急增 / 籌碼集中 / 反轉信號
    │   → ~300
    │
    ├─ T2: RRG Quadrant Filter
    │   ✅ Leading + Improving (keep)
    │   ⚠️  Weakening (keep, flag caution)
    │   ❌ Lagging (remove)
    │   → ~180
    │
    ├─ T3: Risk Exclusion (處置 + 注意 + 連跌停)
    │   → ~160
    │
    ├─ T4: Technical Confirmation
    │   Win rate > 45%, MDD < 25%
    │   → ~80
    │
    ├─ T4.5: RRG Fine-tune
    │   Leading + Mom↓ → confidence -0.03
    │   → ~80 (score adjusted)
    │
    ├─ T4.6: Lagging Final Removal
    │   ML 前最後一關過濾 (省 ~30% 計算)
    │   → ~50
    │
    └─ T5: Profile Enrichment
        News sentiment + company profile + relative strength
        → 30~50 candidates → ML
```

---

## Feature Engineering (26D + 7 CatBoost lags)

```
┌─────────────────────────────────────────────────────────────────┐
│  FEATURE VECTOR (33D per stock)                                 │
│                                                                   │
│  Price Momentum (4):  return_1d, 3d, 5d, 10d                    │
│  Volatility (2):      vol_5d, vol_20d                            │
│  Technical (3):       RSI14, MACD_hist, BB_position              │
│  Volume (2):          vol_ratio_5d, vol_ratio_20d (clip 0.1~10)  │
│  Moving Avg (2):      MA20_bias, MA60_bias                       │
│  Chips (3):           institutional_net, chip_5d, foreign_5d     │
│  Sentiment (2):       sentiment, sentiment_3d (ffill)            │
│  Volatility Proxy (1): ATR14                                     │
│  Market Env (6):      risk_score, risk_level, market_ret_1d/5d,  │
│                       market_bias_20d, stock_vs_market            │
│  CatBoost Lags (7):   RSI14/MACD/vol_ratio lag1+lag3, chip lag1 │
│                                                                   │
│  Target: Triple Barrier Label (Prado 2018)                       │
│    1 = touch upper (ATR×3 or +7%)                                │
│    0 = touch lower (ATR×2 or -3%)                                │
│    NaN = 20D timeout → excluded                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Ensemble Scoring Formula

```
┌─────────────────────────────────────────────────────────────────┐
│  RECOMMENDATION SCORE (0~100)                                   │
│                                                                   │
│  ┌──────────────────┐                                           │
│  │ Chip Score (40%) │  foreign_5d + trust_5d + dealer_net       │
│  │                  │  + chip concentration + margin_delta       │
│  └──────────────────┘                                           │
│  ┌──────────────────┐                                           │
│  │ Tech Score (30%) │  RSI + MACD + BB + MA cross + volume      │
│  │                  │  + Sortino-adj momentum + Hampel cap       │
│  └──────────────────┘                                           │
│  ┌──────────────────┐                                           │
│  │ ML Score  (30%)  │  ensemble confidence × direction           │
│  │                  │  × LinUCB routing × ARF correction         │
│  └──────────────────┘                                           │
│                                                                   │
│  Note: ML 30% 不代表低價值 — ML 控制了:                         │
│  1. Entry timing (是否今天進場)                                  │
│  2. Position sizing (信心度 → 風險分級)                          │
│  3. SL/TP 動態計算 (GARCH, not static)                           │
│  4. Debate 能否通過 (ML signal 是 bull case 核心論據)            │
│  5. Adaptive params (模型準確率 → 下一天門檻)                    │
│                                                                   │
│  Chip+Tech 是 "what to buy"                                     │
│  ML 是 "when/how much/how to exit" — 風控核心                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Ensemble Weight Formula (5-Layer Dynamic)

```
model_weight = walk_forward_accuracy        (0.35 ~ 0.88)
             × self_confidence              (0.0 ~ 1.0)
             × profit_factor_quality_mult   (0.3 ~ 1.4, from adaptive engine)
             × hmm_regime_mult              (0.6 ~ 1.3)
             × linucb_bandit_mult           (0.3 ~ 2.5)

Final signal = weighted_vote(10 models, model_weight)
             → ARF P(up) soft correction (±5%)
             → threshold gate (adaptive, 0.55~0.75)
             → signal strength (1~5 stars)
```

---

## Daily Timeline (Taiwan Time)

```
06:30  us-leading       美股先行指標 (SOX, TSM, VIX, 10Y yield)
07:15  morning-setup    Debate → pending_buys → 限價掛單
07:25  morning-briefing Discord 晨報推送
09:00  [Market Open]
09:00~ intraday-check   每分鐘: 成交判定 + 即時停損 (Shioaji/Yahoo)
13:25  eod-exit         到期 + 觸價強制平倉
13:30  [Market Close]
15:05  bulk-fetch       TWSE + TPEX + 興櫃 bulk 寫入
15:10  screener         T0→T5 多層篩選
15:15  queue-update     Yahoo 回填 + 指標 + 新聞
15:30  ml-predict       10 模型 + ensemble + meta-learner
16:05  adaptive-update  T+1 自適應參數計算
17:00  daily-report     每日報告 + Discord 推送
20:00  daily-snapshot   Portfolio snapshot + PnL 計算
```

---

## Infrastructure

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Workers    │  Orchestrator + API + Cron         │
│  Cloudflare D1         │  38 tables (SQLite edge)           │
│  Cloudflare KV         │  Cache + Config (38 params)        │
│  Cloudflare Queue      │  Per-stock enrichment pipeline     │
│  Cloudflare Pages      │  React frontend (Vite + TailwindCSS)│
├─────────────────────────────────────────────────────────────┤
│  Google Cloud Run      │  ML Service (Python, 10 models)    │
│  Google Cloud Storage  │  Model state persistence (LinUCB, ARF)│
├─────────────────────────────────────────────────────────────┤
│  Cloud Run (Go)        │  Controller: TWSE/TPEX proxy       │
│  Shioaji Proxy         │  即時報價 (Cloud Run)               │
├─────────────────────────────────────────────────────────────┤
│  Discord Webhook       │  晨報 + 日報 + 交易通知            │
│  Local Tunnel          │  Claude Opus (Debate, free)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Sources (Zero FinMind Dependency)

| Category | Source | API | Freq |
|----------|--------|-----|------|
| 上市股價 | TWSE | STOCK_DAY_ALL | Daily |
| 上櫃股價 | TPEX | tpex_mainboard_daily_close_quotes | Daily |
| 興櫃股價+均價 | TPEX | tpex_esb_latest_statistics | Daily |
| 歷史回填 | Yahoo Finance | chart API (1Y) | On-demand |
| 三大法人 | TWSE T86 + TPEX 3itrade | Bulk | Daily |
| 融資融券 | TWSE MI_MARGN + TPEX | via Controller | Daily |
| 估值 PER/PBR | TWSE BWIBBU + TPEX peratio | Bulk | Daily |
| 月營收 | TWSE t187ap05 + TPEX | Bulk | Monthly |
| 財報 EPS/ROE | TWSE opendata | Bulk | Quarterly |
| 大盤廣度 | TWSE twtazu_od | Bulk | Daily |
| 除權息預告 | TWSE TWT48U + TPEX | Bulk | Quarterly |
| 處置股 | TWSE /announcement/punish | KV cached | Daily |
| 注意股 | TWSE /announcement/notice | KV cached | Daily |
| 美股指標 | Yahoo Finance | SOX, TSM, VIX, ^GSPC | Daily |
| PTT 情緒 | PTT Stock Board | Scrape | Daily |
| 新聞 | D1 + Anue 鉅亨 | Aggregate | Daily |
| 集保散戶 | TDCC opendata | v1/opendata/1-5 | Weekly |

---

## Addressing Gemini's Review Points

### 1. "ML 只佔 30% → 昂貴的裝飾品？"

**反論**: 30% 是 recommendation score 的權重，不是 ML 的影響力。ML 實際控制了:

- **Entry gate**: Ensemble confidence < threshold → 不進場（100% 決定權）
- **Position sizing**: Confidence 0.55 vs 0.75 → risk budget 差 2x
- **Dynamic SL/TP**: GARCH volatility → 個股化止損止利（非 static）
- **Debate 核心論據**: Bull case 的信號強度直接影響 Judge verdict
- **Adaptive feedback**: 模型準確率 → T+1 confidence_threshold 調整

Chip(40)+Tech(30) 決定 "買什麼"，ML(30) 決定 "何時買、買多少、怎麼出場"。

### 2. "沒有 Meta-Learner？"

**有兩個 meta-learner:**

1. **LinUCB Contextual Bandit** — 不是第 11 個預測模型，是 model router。根據 [HMM regime, GARCH vol, market risk] 決定當前市場狀態下哪個模型最可信。熊市可能放大 MarkovSwitching 的權重，低波動時放大 LightGBM。

2. **ARF Online Aggregator** — 學習 10 個 base model 的輸出組合（33D feature vector）哪些組合真的預測準確。帶 ADWIN concept drift detection，自動重建過時的分支。

兩者都用 T+1 delayed reward，不會 overfit 當天資料。

### 3. "XGB/LGBM/RF/GB 共線性"

**承認**: 4 個 tree models 確實高度相關。但在 ensemble 裡，LinUCB bandit 會自動 downweight 共線的 arms — 如果 XGB 和 LGBM 在同一市場狀態下表現相同，bandit 會把權重集中到其中一個，另一個接近 0.3x。

**可改進**: Gemini 建議踢掉統計模型（ARIMA/Prophet 已被踢掉，替換為 MarkovSwitching + KalmanFilter）。ExtraTrees 和 CatBoost 可考慮替換為更多元的模型（如 TabNet 或 N-BEATS），但目前 ARF 的 drift detection 已有效處理共線性帶來的 false confidence。

### 4. "漲跌停鎖死無法平倉"

**承認**: 目前 paper trading 的 `limitPrice ≤ 即時價 → 成交` 確實未模擬漲跌停鎖死。

**已有部分防護**:
- Screener T3 排除連續跌停 >3 天
- Circuit Breaker CB4 (VIX>35) 暫停新進場
- 處置股雙重排除

**需補強**: Intraday check 加入「漲跌停鎖定時，即使觸價也不模擬成交」的懲罰機制。

### 5. "三源 Buzz 權重失衡"

**承認**: PTT/News/Anue 的 mentionCount 基數不同。目前用的是 combinedBuzz 簡單加總。

**計劃**: 加入 Z-score normalization（各源獨立標準化後再合併），防止大盤事件時新聞台轟炸淹沒 PTT 散戶情緒。

### 6. "除權息還原權值"

**已處理**: Yahoo Finance chart API 回傳的是 adj_close（還原權值後收盤價），存入 D1 的 adj_close 欄位。ML features.py 使用 adj_close 計算 returns，避免除息跳空污染時間序列。
