# StockVision Roadmap — 30 Items

> Updated: 2026-04-04
> Status: P0 ready to execute

---

## P0 — Trading Quality + Backtest (Week 1-2)

### #1 Optuna Triple Barrier Scan
- **What**: upper_mult[2-4] x lower_mult[1.5-3] x pct_cap[0.03-0.10] x max_days[10-30] + OOS 20% lock
- **Where**: `ml-service/app/features.py` compute_triple_barrier_labels + new `scripts/optuna_barrier.py`
- **Why**: Label quality is the foundation of all 10 models. Current ATR x3/x2 is arbitrary. Wrong labels = all models learn wrong direction
- **Expected**: ML direction accuracy +3-5%

### #2 Optuna Signal + Screener Weight Scan
- **What**: confidence[0.50-0.70] x consensus[0.50-0.72] x signal_score cutoffs + screener weight chip[20-50]:tech[15-40]:mom[10-25]
- **Where**: `ml-service/app/ensemble.py` thresholds + `worker/src/lib/marketScreener.ts` scoring weights
- **Why**: Thresholds too high = all HOLD useless; too low = noise signals lose money. Screener 40:30:20 weights never validated
- **Expected**: Reduce NO_SIGNAL 30%, improve stock selection quality

### #3 Optuna SL/TP + Trailing Scan
- **What**: sl_mult[1.0-3.0] x tp_mult[1.0-3.0] x timeStop[10-30] x tp1Ratio[0.3-0.7] + trailing 3-stage mult and switch points (profit 3%/5%/8% each stage mult[1.5-3.5])
- **Where**: `worker/src/lib/tradingConfig.ts` + `ml-service/app/ensemble.py` SL/TP calculation
- **Why**: Stop loss / take profit directly determines win/loss ratio per trade. Trailing 3-stage is hardcoded
- **Expected**: Profit Factor +0.2-0.5

### #4 Automated Backtest Cron ✅
- **What**: Sunday cron: D1 export → in-memory backtest (7-layer cascade) → D1 backtest_results table
- **Where**: `ml-controller/services/backtest_service.py` + `ml-controller/routers/backtest.py` + `worker/src/index.ts` Sunday cron
- **Why**: Frontend Backtest card shows "no results". Scripts exist but never auto-triggered. backtest_results table is empty
- **Expected**: Frontend shows weekly updated strategy performance
- **Impl**: Python backtester on Cloud Run mirroring StockVisionStrategy (no Freqtrade binary needed). Worker → Controller POST /backtest/run → D1

### #5 Monte Carlo MDD ✅
- **What**: Shuffle paper_orders trade sequence 1000x, calculate 95th percentile worst-case MDD distribution
- **Where**: `ml-controller/services/monte_carlo_service.py` + `ml-controller/routers/backtest.py` POST /backtest/monte-carlo
- **Why**: Currently only know historical MDD. Don't know "worst case if unlucky". This number decides if strategy can go live with real money
- **Expected**: 95% confidence MDD ceiling (e.g. "MDD won't exceed 18% with 95% confidence")
- **Impl**: FIFO order pairing from paper_orders + backtest trades, 1000x shuffle, go-live verdict (PASS/CAUTION/FAIL). Worker GET /api/backtest/monte-carlo for frontend

### #6 PBO (Probability of Backtest Overfitting) ✅
- **What**: Combinatorial Purged Cross-Validation: multiple train/test splits, calculate probability strategy loses money OOS
- **Where**: `ml-controller/services/pbo_service.py` + `ml-controller/routers/backtest.py` POST /backtest/pbo
- **Why**: Answers "is this alpha real or curve-fitting?" PBO < 0.5 = alpha credible. > 0.5 = ban from going live
- **Expected**: Binary go/no-go decision for live trading
- **Impl**: CPCV with 10 partitions, C(10,5)=252 combinations, Worker cron + GET /api/backtest/pbo

### #7 Sortino / Calmar / CAGR ✅
- **What**: Add 3 metrics to daily_snapshot + backtest card: Sortino, Calmar (CAGR/MDD), CAGR
- **Where**: `worker/src/routes/paper.ts` runDailySnapshot + `frontend/src/pages/BotDashboard.tsx` BacktestCard
- **Why**: Sharpe penalizes all volatility including upside. Sortino is more appropriate for trading strategy evaluation
- **Expected**: Complete performance metrics on frontend
- **Impl**: Sortino 30d (downside-only), CAGR from inception, Calmar = CAGR/MDD. Frontend shows 9 metrics + MC/PBO verdict badges

---

## P1 — Self-Learning + Architecture (Week 3-6)

### #8 Model Lifecycle (Downweight / Shadow / Replace / Restore) ✅
- **What**: 30d accuracy < 0.45 for 2 consecutive weeks → downweight to 0.05x. Restore > 0.55 → back to 1.0x. Balance guard: min 3 price + 3 feature models active. Substitute library with matching rules
- **Where**: `universal/model_pool.json` + `ml-controller/routers/model_pool.py` + `ml-controller/services/model_ic_tracker.py` + `ml-controller/services/lifecycle_promotion_gate.py` + `worker/src/lib/controllerDailyWorkflows.ts`
- **Why**: Bad model drags ensemble down. LinUCB downweights too slowly. Replacement has evidence (cause → candidate match)
- **Expected**: Ensemble quality auto-maintained
- **Impl**: Weekly `model-ic-tracker` cron calls `/model_pool/compute_weekly_ic`, then `/model_pool/promote_check`; lifecycle state, events, lineage, weights, shadow / promote / degrade decisions live in `model_pool.json`.

### #9 Feature IC -> Retrain Feedback + Model Hyperparameter Optuna ✅
- **What**: IC audit weak features excluded during retrain. Optuna 20-trial search per model (XGB/CatBoost/ExtraTrees/LightGBM)
- **Where**: `worker/src/index.ts` reads KV `ml:weak_features` → retrain payload. `ml-service/app/main.py` filters features + runs Optuna. `ml-service/app/optuna_retrain.py` search spaces
- **Why**: Previously retrain used all 32 features (including noise) with hardcoded hyperparams
- **Expected**: Reduce overfitting, model accuracy +2-3%
- **Impl**: Worker passes weak_features + use_optuna in payload. ML service drops weak features (guard: keep >=5). Optuna searches depth/lr/n_estimators/subsample per model. Falls back to defaults if Optuna fails

### #10 Meta-layer Dynamic Adjustment ✅
- **What**: ARF warm-up dynamic (vol→30/80), Stacking blend dynamic (meta_acc vs ensemble_acc → 30-70%), LinUCB alpha dynamic (loss_rate → 0.1-0.7)
- **Where**: `ml-service/app/arf_aggregator.py` get_dynamic_min_obs + `ml-service/app/ensemble.py` dynamic meta_ratio + `ml-service/app/linucb_bandit.py` compute_dynamic_alpha
- **Why**: Three meta components were all hardcoded. Now self-adjusting based on market conditions
- **Expected**: Losing → explore. Winning → exploit. High vol → fast adapt

### #11 LangGraph Integration in Controller ✅
- **What**: Daily pipeline as StateGraph: screener → ML → recommend with JSON checkpoint + retry 3x + auto-pass
- **Where**: `ml-controller/graphs/daily_pipeline.py` + `ml-controller/routers/pipeline.py` POST /pipeline/run
- **Why**: Previously if ML predict fails, recommendation runs with empty predictions
- **Expected**: Pipeline resilience + resumable from checkpoint
- **Impl**: Lightweight custom StateGraph (no langgraph dep). 3x retry per step with exponential backoff (2/5/15s). Checkpoint after each step. Dependency chain: screener → ml_predict → recommend. POST /pipeline/run with resume + date params

### #12 Portfolio Construction + Position Replacement
- **What**: Three sub-systems:

  **A. ATR Fixed-Risk Position Sizing** (replace current `maxPctOfCash` 30% cascading)
  - `risk_per_trade = totalPortfolio × riskPct` (default 1.5%)
  - `stop_distance = ATR14 × slMultiplier` (existing initial_stop logic)
  - `shares = risk_per_trade / stop_distance`
  - Batch allocation: receive all daily recommendations → calculate all at once → no order dependency
  - Upper bound: `position_value <= 25% portfolio` and `<= dailyBuyLimit`
  - Lower bound: `position_value >= 30,000` (below this not worth transaction cost)
  - Solves: first stock gets 25万 vs fifth stock gets 5万 imbalance. Every position now has equal "loss if stopped out"

  **B. maxPositions Hard Cap** (new: currently no limit)
  - `maxPositions: 5` in tradingConfig.ts
  - Current system relies on cash depletion to naturally limit positions (can reach 6-7)

  **C. Position Replacement** (new: currently skips new signals when full)
  - Trigger: positions = maxPositions AND new recommendation arrives
  - Step 1: Calculate `weakness_score` for each holding:
    - Unrealized PnL rank (more loss = weaker) — 30%
    - Holding days / timeStopDays ratio — 15%
    - Latest ML signal (SELL=0, HOLD=30, BUY=70) — 25%
    - RRG quadrant (Lagging=0, Weakening=30, Improving=60, Leading=100) — 15%
    - Technical decay (RSI<50 or MACD cross-down or 3-day losing streak) — 15%
  - Step 2: Compare new vs weakest. ALL conditions must be met:
    - `new_total_score > weakest_total_score × 1.15` (15% threshold, higher than US 10% due to TW tax)
    - weakest held >= 3 days (avoid churn)
    - weakest NOT near TP1 trigger (price < tp1_price × 0.97)
    - Expected net gain > 1.5% (covers TW swap cost: sell 0.1425%+0.3% tax + buy 0.1425%+0.1% slippage ≈ 0.685% + safety margin)
  - Step 3: Execute swap or skip. `max_daily_swaps: 1`. Log skipped recommendations
  - Sector check: if new stock's sector already has 2 holdings → don't swap even if score is higher

  **Interaction with existing 7-layer exit**: No conflict. ATR sizing decides "how much to buy" at entry. 7-layer exit decides "when to sell" during holding

- **Where**: `worker/src/routes/paper.ts` + `worker/src/lib/tradingConfig.ts`
- **Why**: Three problems: (1) No position count limit. (2) Full positions → new signals ignored. (3) No weakness evaluation
- **Expected**: Portfolio Sharpe +0.3-0.5, position sizes balanced
- **Status**: ✅
- **Impl**: maxPositions=5 hard cap. Weakness score = pnlPct(35%) + timeRatio(25%) + tp1Status(20%) + negPnl(20%). Swap: new score must exceed weakest×1.15, held>=3d, not near TP1. Max 1 swap/day. minPositionValue=30K guard. Sell order logged as SWAP_OUT with reason

### #13 Execution Reality ✅
- **What**: Volume-based slippage + partial fill + limit-down lock detection
- **Where**: `worker/src/routes/paper.ts` applySlippage/applyPartialFill/isLimitDownLocked
- **Why**: Paper trading assumed 100% fill at market price
- **Expected**: Paper PnL closer to reality
- **Impl**: Slippage: <10M turnover → +3 ticks, <50M → +1 tick. Partial fill: order >5% daily vol → fill 80%. Limit-down: drop >=9.5% + vol <10% prev → block sell

### #14 Prompt Injection Detection ✅
- **What**: Detect dangerous patterns in LLM output, auto-downgrade/reject verdict
- **Where**: `ml-controller/security/injection.py` (Python) + `worker/src/lib/debateTrader.ts` (TS inline)
- **Why**: debateTrader uses news as context. News could contain embedded prompt injection
- **Expected**: Prevent LLM manipulation affecting trade decisions
- **Impl**: 10 regex patterns (critical/high/medium). Critical → REJECT, High → DOWNGRADE. Patterns: instruction_override, role_hijack, extreme_action, insider_claim, urgency_manipulation, unrealistic_claim. Both Python (for controller-side use) and TypeScript (inline in debateTrader) implementations

### #15 Three-layer Observability ✅
- **What**: L1 Trade (existing). L2 Decision: per-trade factor attribution. L3 Model: daily per-model health
- **Where**: `worker/src/routes/paper.ts` L2 decision_logs + `worker/src/index.ts` L3 model_health_daily + KV
- **Why**: Currently can only see "PnL is bad". Can't diagnose which layer is wrong
- **Expected**: Answer "why are we losing money" with data
- **Impl**: L2: INSERT decision_logs on each BUY with chip_pct/tech_pct/ml_pct contribution + debate verdict. L3: After daily verify, snapshot all 10 models' accuracy/PF/expectancy/lifecycle to D1 + KV. API: GET /api/observability/decisions + /model-health

---

## P2 — Advanced Evolution (Week 7-12) ✅ All Complete

### #16 Weekly AI Audit Report
- **What**: Friday post-close Controller LangGraph graph: read L1/L2/L3 data -> performance diagnosis + params vs Optuna optimal comparison + model health + substitute recommendation (lookup table match, not LLM hallucination) -> LLM writes human-readable report -> Discord push + D1 archive
- **Where**: `ml-controller/graphs/weekly_audit_graph.py` (new)
- **Why**: "Why are we losing?" -> system auto-answers: "XGBoost degraded -> downweighted. Suggest threshold 0.55->0.63. Market weak, alpha near 0"
- **Expected**: Automated weekly diagnosis replacing manual DB queries

### #17 Red-Blue Army: Historical Replay
- **What**: Load 2020/03 COVID (TWII -26%), 2022 Bear (-25%), 2008 Financial Crisis (-50%) complete daily data. Replay through pipeline -> record MDD, Circuit Breaker reaction time, recovery days
- **Where**: `ml-controller/graphs/adversarial_graph.py` (new) + historical data in GCS
- **Why**: Know worst-case performance. Robustness score > 60 = can go live with real money
- **Expected**: Quantified robustness score for live trading decision

### #18 Red-Blue Army: Synthetic Stress
- **What**: Generate synthetic scenarios: false breakout trap (5 days institutional buying -> day 6 gap down -5%), model co-error (10 models all predict wrong), liquidity evaporation (3 consecutive limit-down), flash crash (single day -7%)
- **Where**: `ml-controller/services/stress_generator.py` (new)
- **Why**: Find hidden bugs proactively. e.g. "trailing stop can't execute on limit-down days"
- **Expected**: Discover bugs before real money does

### #19 RRG Full Parameter Grid Search
- **What**: 125 combinations rsWindow[10-30] x emaSpan[5-15] x momLookback[5-15]. Evaluate: Leading quadrant stocks 5d excess return. Plateau detection (neighbor |delta| < 0.5% = robust zone -> take center)
- **Where**: `worker/src/lib/marketScreener.ts` calcIndustryRRG + new weekly calibration script
- **Why**: Don't find single optimal point (overfits). Find most robust plateau region
- **Expected**: Leading stock selection 5d excess return +1-2%

### #20 Circuit Breaker + Trailing + Replacement Optuna
- **What**: drawdownHalt[0.08-0.20] x maxPositionPct[0.04-0.12] x highVolReducedPct[0.02-0.06] + trailing 3-stage switch points profit%[2-5, 4-8, 7-12] and per-stage mult[1.5-3.5] + **position replacement params**: riskPct[0.01-0.025] x score_diff_threshold[0.10-0.25] x min_hold_days[3-7] x min_position_value[20000-50000] x max_daily_swaps[1-2]
- **Where**: `worker/src/lib/tradingConfig.ts`
- **Why**: Risk control not too conservative (good runs blocked) or too aggressive (should stop but didn't)
- **Expected**: Optimal risk-adjusted Sharpe

### #21 Stacking MLP Shadow Mode
- **What**: MLP [30->16->8->2] + Dropout 0.3 + Early stopping runs parallel with LR. LR+Poly degree=2 also parallel. Three-way weekly OOS comparison. MLP > LR x 1.1 + PBO < 0.4 + 4 consecutive weeks lead -> you confirm to switch
- **Where**: `ml-service/app/stacking.py` + new `ml-service/app/stacking_mlp.py`
- **Why**: Zero risk experiment. LR continues stable production. MLP proves itself with real data before any switch
- **Expected**: Data-driven meta-learner upgrade (if MLP actually proves better)

### #22 FT-Transformer Online Update
- **What**: After daily verify, fine-tune last 2 layers with new 5-day (X, y) data (lr=1e-4, 3 epochs). Don't touch embedding layers. Full retrain only on Sunday
- **Where**: `ml-service/app/models.py` run_ft_transformer + Modal warm container
- **Why**: Deep model currently frozen for 1 week between retrains. Online update = "yesterday's knowledge" vs "last week's knowledge"
- **Expected**: Faster adaptation to market regime changes

### #23 PTT Sentiment 4 Features into ML
- **What**: `features.py` add: mention_count, sentiment_ratio, volume_change_on_mention, buzz_to_price_lag. Connect to IC audit for validation
- **Where**: `ml-service/app/features.py` + `worker/src/lib/pttBuzz.ts` data bridge
- **Why**: PTT buzz currently only +/-5 screener points. Not in ML features. ML could learn "PTT hot -> short-term price" patterns
- **Expected**: ML accuracy +1-2% (if IC validates; auto-removed if IC < 0.02)

### #24 Conformal Prediction Auto-Calibration
- **What**: coverage[0.80-0.95] searched by Optuna (objective: minimize gap between calibrated_confidence and actual accuracy). min_calibration_size[15-30] and max_residuals[300-700] also searched
- **Where**: `ml-service/app/conformal.py` + Optuna script
- **Why**: 90% coverage is a guess. Optuna finds most accurate calibration params -> confidence scores become trustworthy
- **Expected**: Confidence score actually predicts real accuracy

### #25 Screener Grading -> Continuous Percentile
- **What**: Replace hardcoded grading rules (>10B=36, >5B=28...) with percentile ranking: each factor's percentile in universe x max score. No more hardcoded breakpoints
- **Where**: `worker/src/lib/marketScreener.ts` scoreMultiFactor
- **Why**: Eliminate grading cliff effect. 9.9B and 10.1B currently differ by 8 points (36 vs 28). Percentile = smooth, fair
- **Expected**: Better discrimination between similar stocks

### #26 7-Layer Exit -> Dynamic Priority
- **What**: Each exit layer gets a priority score based on market regime. High vol -> hard stop highest priority. Trending -> trailing highest. Sideways -> TP1 partial highest. Priority scores searched by Optuna per-regime
- **Where**: `worker/src/routes/paper.ts` checkExitConditions + `worker/src/lib/tradingConfig.ts`
- **Why**: Currently one fixed exit order for all market conditions. Sideways market should take profit aggressively; trending market should let winners run
- **Expected**: Exit strategy adapts to market condition

### #27 Feature Window Optuna
- **What**: volatility[3-10, 10-30] x vol_ratio[3-10, 10-30] x MA_bias[10-30, 40-80] window search. Return windows [1,3,5,10,20] also searched
- **Where**: `ml-service/app/features.py` build_feature_matrix
- **Why**: 5d/20d windows are human-decided. Maybe 7d/15d is better. Optuna finds highest IC window combinations
- **Expected**: Feature quality improvement -> all models benefit

---

## P3 — Intelligence Evolution (建議時程)

### Phase 1: SHAP 歸因（Now，1 週內）
- **#31 SHAP Feature Attribution**
- **What**: 每筆交易用 SHAP 解釋 10 個模型各 feature 的貢獻度。Obsidian Trade note 自動顯示「這筆虧損主因是 RSI 誤判」
- **Where**: `ml-service/app/ensemble.py` 加 `shap.TreeExplainer` + Obsidian trade.md.j2 加 SHAP section
- **Why**: Optuna 找最佳參數，SHAP 解釋為什麼。兩者互補。低成本高洞察
- **Expected**: 每筆交易可追溯到具體 feature，累積 50+ 筆後 pattern 自然浮現
- **Effort**: Low（tree model 天然支援 SHAP）

### Phase 2: Regime-conditional Optuna + RL Shadow Framework（1-3 個月）
- **#32 Per-Regime Parameter Search**
- **What**: 不再搜全局最佳參數，而是每個 HMM regime 各搜一組。低波動牛市用一組 SL/TP，震盪整理用另一組
- **Where**: `scripts/optuna_*.py` 改 objective 分 regime 跑 + `ml:adaptive_params` 改為 per-regime dict
- **Why**: 一組參數應對不了所有盤勢。震盪市該用緊 trailing，趨勢市該放寬
- **Expected**: 不同 regime 的 Sharpe 各自提升 0.1-0.3
- **Prerequisite**: 已有 HMM regime detector + regime_config KV 化 ✅
- **Effort**: Med

- **#29 RL Shadow Framework（搭框架，不上線）**
- **What**: 搭好 gym environment + 用回測資料訓練 shadow RL。output 只記錄不執行，等 6 個月後有足夠真實交易再 evaluate
- **Where**: `ml-service/app/rl_advisor.py`（gym env）+ `ml-service/app/rl_shadow.py`（shadow mode 記錄）
- **Why**: RL 需要大量資料但框架可以先搭。現在開始用回測訓練，同步累積 paper trading 真實資料
- **⚠️ Shadow only**: 預測結果記錄到 D1 `rl_shadow_predictions` 表，不影響任何實際交易決策
- **Effort**: Med-High（gym env + PPO/SAC 選型 + 回測 episode 建構）

### Phase 3: GNN + LLM Strategy Gen + Loss Mining（3-6 個月）
- **#28 Graph Neural Network (Cross-stock Relations)**
- **What**: 用 60 天報酬率 correlation matrix 自動建圖（不需供應鏈資料），GNN 學跨股票共動模式
- **Where**: New model in `ml-service/app/gnn_model.py`（PyTorch Geometric）
- **Why**: 所有現有模型獨立預測每檔股票。GNN 捕捉「台積電漲 → 哪些供應商跟著動」
- **Data**: 165 萬筆 OHLCV ✅ + 38 個 TWSE 產業分類 ✅ + correlation 自動建邊
- **Mode**: **Shadow mode 先跑** — GNN 預測記錄但不進 ensemble，連續 4 週 OOS > 現有模型才納入
- **Effort**: High（PyTorch Geometric + 圖建構 + ensemble 整合）

- **#30 LLM Strategy Generation**
- **What**: Claude 讀 SHAP 歸因 + 虧損 clustering → 提出 feature 假設 → Optuna IC 驗證 → 你確認
- **Where**: `ml-controller/graphs/strategy_gen_graph.py` (new)
- **Why**: SHAP 說「RSI 害你虧」→ LLM 提出「加 RSI 二階導數 feature」→ IC 自動驗證
- **Prerequisite**: #31 SHAP 累積 50+ 筆交易
- **Effort**: Med

- **#33 Loss Pattern Mining**
- **What**: K-Means clustering 虧損交易（sector, regime, hold_days, exit_reason, SHAP attribution）→ 自動分類虧損類型 → 餵 #30 LLM Gen
- **Where**: `ml-controller/services/loss_mining.py` (new)
- **Why**: 從「個別虧損」看到「系統性問題」。3 筆不相關虧損可能是同一個 regime + trailing 缺陷
- **Effort**: Med

### Phase 4: GA Ensemble + GNN 上線 + RL Evaluate（6+ 個月）
- **#34 Genetic Algorithm Ensemble Weights**
- **What**: GA 搜 10 模型 w1~w10 權重。crossover 天然抓參數交互效果
- **Where**: `ml-service/scripts/ga_ensemble.py` (new)
- **Why**: 10 維空間 Optuna 效率差，GA 更適合
- **Prerequisite**: **350+ 筆交易**（8 筆搜 10 權重 = 100% overfitting，數學上不行）
- **Why not now**: 8 筆交易、150 組候選 = GA 會選中「剛好在 8 筆上表現好」的權重，換新交易全錯
- **Effort**: Med

- **#28 GNN 正式上線**: Shadow 連續 4 週 OOS 勝出 → 納入 ensemble 作為第 11 個模型
- **#29 RL Evaluate**: 對比 shadow RL policy vs rule-based Layer 1-7 的出場時機，證明更好才上線

### RL 上線安全規則（Phase 4 通過驗證後才適用）
```
架構：
Layer 1-7: 原封不動（風控骨幹，不可被 RL 覆蓋）
Layer 8: RL Advisor（建議層）
  ├── RL 說「建議現在賣」→ 觸發 early exit
  ├── RL 說「建議繼續抱」→ 放寬 trailing（但 Layer 1 hard stop 永遠生效）
  └── RL 和 Layer 1-7 衝突 → Layer 1-7 優先（風控永遠有最終否決權）

⚠️ Safety: Hard stop -12% + Circuit Breaker = immutable。RL 不能覆蓋。
```

---

## Hardcode Elimination Progress

| Phase | Auto-Learning | Still Hardcode | Intentionally Manual |
|---|---|---|---|
| **P0-P2 done** | 85% | 5% | 10% |
| **P3 Phase 1-2** | 90% | 0% | 10% |
| **P3 Phase 3-5** | 95% | 0% | 5% |

**Intentionally manual (never auto)**:
- Universe filter（策略定義：做哪些市場）
- Hard stop -12%（最後防線：永遠不能被優化掉）
- Fees/tax（法規：0.1425% 手續費、0.3% 交易稅）
- Model replacement confirmation（你的決定：砍模型必須人工確認）
- RL Layer 8 不能覆蓋 Layer 1-7（風控架構原則）

---

## Timeline

```
✅ Done              Now                  1-3 months           3-6 months           6+ months
────────────        ─────────            ──────────           ──────────           ──────────
P0 #1-7 ✅          #31 SHAP 歸因        #32 Regime Optuna    #28 GNN (shadow)     #34 GA Weights
P1 #8-15 ✅                              #29 RL framework     #30 LLM Gen          #28 GNN 上線
P2 #16-27 ✅                             (shadow, 不上線)     #33 Loss Mining      #29 RL evaluate
47 params KV ✅
Obsidian ✅
Data Backfill ✅

Intelligence:  Rule-based → Optuna-tuned → SHAP-explained → Regime-adaptive → Cross-stock → RL-assisted
Evolution:     6/10         8/10            8.5/10              9/10                 9.5/10       10/10

Shadow Mode 原則：GNN、RL 都先跑 shadow（預測記錄但不交易），連續 4 週 OOS 勝出才納入正式 ensemble
GA 等待原則：350+ 筆交易前不跑（8 筆搜 10 維 = 純 overfitting）
RL 安全原則：上線後只能「加速出場」不能「阻止出場」，Layer 1-7 風控永遠優先
```

---

## Pending Action Items (手動執行)

### 🔴 Deploy 前完整驗證流程（按順序執行）
1. [x] 跑所有 D1 migrations（8 個 .sql）— ✅ 2026-04-06
2. [x] 跑 `backfill_delisted_stocks.py` 補齊下市股資料 — ✅ 10 檔 TWSE/TPEX（不用 FinMind）
3. [x] Optuna P0#1-3 重搜 — ✅ 結果推 KV（barrier+signal+sltp）
4. [ ] 完整回測（新滑價 + ATR TP + point-in-time universe）
5. [ ] Monte Carlo MDD（驗證 95th MDD < 20%）
6. [ ] PBO（驗證 PBO < 0.5）
7. [ ] **確認 MC=PASS + PBO=PASS 才能上真錢。任一 FAIL 就停下查原因。**

### ✅ Data Backfill（已完成 2026-04-06）
- [x] 下市股 OHLCV：10 檔，4,319 bars（TWSE/TPEX API，不用 FinMind）
- [x] 現存股 Yahoo backfill：2,329 檔，2023-01-01 ~ 2025-03-24
- [x] 缺失股 TWSE/TPEX 補齊：324 檔，4,775 bars
- [x] migration_stock_pit.sql：listed_date / delisted_date 欄位
- **最終：1,662,865 筆 stock_prices，2,345 檔股票，2023-01-03 ~ 2026-04-02**

### 🟢 回測 / 參數搜索頻率
| 類型 | 頻率 | Cron | 說明 |
|---|---|---|---|
| **常規回測** | 每週 | `0 22 * * 6`（週日 06:00 TW） | 追蹤策略績效是否退化 |
| **MC + PBO** | 每週 | 同上（回測後自動跑） | go-live verdict 每週更新 |
| **Optuna 參數重搜** | 每月 | `0 16 1-7 * 6`（每月第一個週六 00:00 TW） | P0#1-3 重搜，適應市場結構變化 |
| **完整驗證** | 重大改動後 | 手動觸發 | 改了 ensemble/出場/模型後必跑 |
| **Ensemble w1~w6 搜索** | 每季（手動） | — | 需 350+ 筆交易，目前等權 |

業界參考：搖擺交易策略（持倉 10-20 天）通常每週回測 + 每月參數重搜。
Optuna 不是類神經網路 — 它是 hyperparameter 搜索框架（Tree-Structured Parzen Estimator），
用貝葉斯優化找最佳參數組合。每月重搜是為了適應市場 regime 變化，
跟「模型訓練」不同 — 訓練是每週日 retrain，搜索是每月重新找最佳參數。

### 🟡 P2 部署時需要接線（程式碼已寫好，尚未接入 cron）
- [ ] **MLP Shadow (#21)**：在 `retrain_stock()` 中呼叫 `train_shadow_mlp()`，追蹤 4 週 MLP vs LR 結果
- [ ] **FT Online Update (#22)**：在 `runPredictionVerification` 後呼叫 `online_update_ft_transformer()`，每日微調最後 2 層

### 🟡 Ensemble Learned Weights（350+ 筆交易後）
- [ ] 3 年回測跑完，確認交易筆數 >= 350
- [ ] 用 Optuna 搜索 ensemble log-linear 係數 w1~w6
  - 目前：等權（w1=w2=...=w6=1.0）
  - 搜索後：每個因子有不同的重要性（例如 accuracy 可能比 regime 重要 3 倍）
  - 位置：`ml-service/app/ensemble.py` log_w 計算

### ✅ D1 Migrations（全部已跑 2026-04-06）
- [x] `worker/migration_stock_pit.sql`
- [x] `worker/migration_model_lifecycle.sql`
- [x] `worker/migration_monte_carlo.sql`
- [x] `worker/migration_pbo.sql`
- [x] `worker/migration_paper_snapshot_v4.sql`
- [x] `worker/migration_observability.sql`
- [x] `worker/migration_weekly_audit.sql`
- [x] `worker/migration_financials_v2.sql` — operating_income/net_income/total_assets/total_liabilities

---

## ✅ Obsidian Second Brain Integration（已完成 2026-04-06）

### 架構
```
Worker cron 18:40 TW → POST Controller /obsidian/daily
  → obsidian_writer.py 讀 D1 → Jinja2 模板 → GitHub Git Trees API batch push
  → Angus-brain repo: Daily/ + Trades/ + Pipeline/ + Current-State.md
  → stock-analyzer repo: progress.md（Claude 跨 session 記憶）
```

### 已完成
- [x] **Vault**: `AngusRepo/Angus-brain`（GitHub Private Repo）
- [x] **obsidian_writer.py**: D1 → Jinja2 → GitHub push（Daily + Trade + Pipeline + Weekly Review）
- [x] **progress.md 自動同步**: 每日壓縮摘要推到兩個 repo
- [x] **Cron**: Worker `40 10 * * 1-5`（18:40 TW）自動觸發
- [x] **Templates**: daily.md.j2 / trade.md.j2 / pipeline.md.j2 / weekly_review.md.j2 / progress.md.j2
- [x] **Deploy**: Controller Cloud Run + Worker cron 已上線

### Vault 結構
```
Angus-brain/                    ← Personal Second Brain
├── StockVision/
│   ├── Daily/                  ← 每日自動生成
│   ├── Trades/                 ← 每筆交易 note
│   ├── Pipeline/               ← 每日選股流程
│   └── Audits/Weekly/          ← 週報
├── Projects/                   ← 各專案筆記
├── Learning/                   ← 學習筆記
├── Current-State.md            ← Claude context（自動更新）
└── ...
```
