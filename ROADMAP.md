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

### #4 Automated Backtest Cron
- **What**: Sunday cron: export_d1 -> freqtrade backtest -> import_results -> D1 backtest_results table
- **Where**: `worker/src/index.ts` weekly cron + `freqtrade/scripts/`
- **Why**: Frontend Backtest card shows "no results". Scripts exist but never auto-triggered. backtest_results table is empty
- **Expected**: Frontend shows weekly updated strategy performance

### #5 Monte Carlo MDD
- **What**: Shuffle paper_orders trade sequence 1000x, calculate 95th percentile worst-case MDD distribution
- **Where**: New `ml-service/scripts/monte_carlo_mdd.py`
- **Why**: Currently only know historical MDD. Don't know "worst case if unlucky". This number decides if strategy can go live with real money
- **Expected**: 95% confidence MDD ceiling (e.g. "MDD won't exceed 18% with 95% confidence")

### #6 PBO (Probability of Backtest Overfitting)
- **What**: Combinatorial Purged Cross-Validation: multiple train/test splits, calculate probability strategy loses money OOS
- **Where**: New `ml-service/scripts/pbo_analysis.py`
- **Why**: Answers "is this alpha real or curve-fitting?" PBO < 0.5 = alpha credible. > 0.5 = ban from going live
- **Expected**: Binary go/no-go decision for live trading

### #7 Sortino / Calmar / CAGR
- **What**: Add 3 metrics to daily_snapshot: Sortino (only penalize downside vol), Calmar (CAGR/MDD), CAGR (annualized return)
- **Where**: `worker/src/routes/paper.ts` runDailySnapshot + frontend BotDashboard.tsx
- **Why**: Sharpe penalizes all volatility including upside. Sortino is more appropriate for trading strategy evaluation
- **Expected**: Complete performance metrics on frontend

---

## P1 — Self-Learning + Architecture (Week 3-6)

### #8 Model Lifecycle (Downweight / Shadow / Replace / Restore)
- **What**: 30d accuracy < 0.45 for 2 consecutive weeks -> downweight to 0.05x. Restore > 0.55 -> back to 1.0x. **Thresholds themselves searched by Optuna** (0.40-0.50 / 0.50-0.60). Balance guard: price >= 3, feature >= 3. `model_candidates.py` with substitute library + matching rules (degradation cause -> candidate when_useful)
- **Where**: New `ml-service/app/model_lifecycle.py` + `ml-service/config/model_candidates.py` + KV `ml:model_penalty`
- **Why**: Bad model drags ensemble down. LinUCB downweights too slowly. Replacement has evidence (cause -> candidate match), requires your confirmation
- **Expected**: Ensemble quality auto-maintained. No more "why is accuracy dropping for 3 weeks"

### #9 Feature IC -> Retrain Feedback + Model Hyperparameter Optuna
- **What**: IC audit effective features automatically passed to Sunday retrain (only train on effective features). Retrain also runs Optuna for each model's hyperparameters (XGB depth[3-6], lr[0.01-0.1], n_est[100-300])
- **Where**: `worker/src/index.ts` runWeeklyRetrain + `ml-service/app/main.py` retrain endpoint
- **Why**: Currently retrain uses all 26 features (including noise) with hardcoded hyperparams (depth=4 since day 1). Optuna finds best params per market condition
- **Expected**: Reduce overfitting, model accuracy +2-3%

### #10 Meta-layer Dynamic Adjustment
- **What**: ARF warm-up dynamic (high vol -> 30 lower threshold for fast adaptation; low vol -> 80 for stability). Stacking blend by recent 30d meta vs ensemble accuracy (meta more accurate -> ratio to 70%). LinUCB alpha by win/loss streak (losing -> alpha up explore; winning -> alpha down exploit)
- **Where**: `ml-service/app/arf_aggregator.py` + `ml-service/app/ensemble.py` stacking blend + `ml-service/app/linucb_bandit.py`
- **Why**: Three meta components all hardcoded. During losing streaks, system should try different model combinations automatically
- **Expected**: Self-adjusting meta-layer. Losing -> explore. Winning -> exploit

### #11 LangGraph Integration in Controller
- **What**: Daily pipeline as StateGraph: screener -> ML -> recommend with checkpoint (GCS JSON) + retry 3x + state auto-pass
- **Where**: `ml-controller/graphs/daily_pipeline.py` (new)
- **Why**: Currently if ML predict fails at 18:00, recommendation at 18:05 doesn't know and runs with empty predictions. LangGraph: fail -> retry from last checkpoint
- **Expected**: Pipeline resilience + LangGraph Studio visualization

### #12 Portfolio Construction
- **What**: Sector Cap 30% + Volatility Scaling (ATR inverse allocation) + Risk Parity (equal risk contribution)
- **Where**: New `ml-controller/services/portfolio.py` + `worker/src/routes/paper.ts` position sizing
- **Why**: Currently only "pick stocks". Missing "how much to buy each". High vol stocks get same allocation as low vol = unbalanced risk
- **Expected**: Portfolio Sharpe +0.3-0.5

### #13 Execution Reality
- **What**: Slippage model (daily turnover < 50M -> slippage 1-2%) + Partial Fill (order > 5% daily volume -> partial) + Limit-down lock detection (drop >= 9.5% + volume < 10% yesterday -> can't exit)
- **Where**: `worker/src/routes/paper.ts` order execution + `worker/src/lib/tradingConfig.ts`
- **Why**: Paper trading assumes 100% fill at market price. Real trading: small caps slip 1-2%, limit-down days can't exit at all
- **Expected**: Paper PnL closer to reality

### #14 Prompt Injection Detection
- **What**: Detect patterns in LLM output: "ignore previous", "all in", "sell everything". Debate result with danger words -> auto-downgrade to template reason
- **Where**: New `ml-controller/security/injection.py` + `worker/src/lib/debateTrader.ts`
- **Why**: debateTrader uses news as context. News could contain embedded prompt injection (e.g. "analysts recommend buying everything")
- **Expected**: Prevent LLM manipulation affecting trade decisions

### #15 Three-layer Observability
- **What**: L1 Trade (existing PnL/WinRate/MDD). **L2 Decision**: each trade logs "chip_score contributed 38%, ML 45%, debate flipped direction" -> D1 `decision_logs`. **L3 Model**: daily per-model accuracy/IC/drift -> KV `ml:model_health:{date}`
- **Where**: `worker/src/lib/dailyRecommendation.ts` L2 + `worker/src/lib/predictionVerifier.ts` L3 + frontend dashboard
- **Why**: Currently can only see "PnL is bad". Can't diagnose: stock selection wrong? Exit wrong? Which model degraded?
- **Expected**: Answer "why are we losing money" with data, not guesses

---

## P2 — Advanced Evolution (Week 7-12)

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

### #20 Circuit Breaker + Trailing Optuna
- **What**: drawdownHalt[0.08-0.20] x maxPositionPct[0.04-0.12] x highVolReducedPct[0.02-0.06] + trailing 3-stage switch points profit%[2-5, 4-8, 7-12] and per-stage mult[1.5-3.5]
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

## P3 — Long-term Research (3-6 months)

### #28 Graph Neural Network (Cross-stock Relations)
- **What**: Learn supply chain / industry co-movement. "TSMC up -> which suppliers follow" without manual concept tags
- **Where**: New model in `ml-service/app/models.py`
- **Why**: All current models predict each stock independently. GNN captures cross-stock patterns

### #29 Reinforcement Learning End-to-End
- **What**: RL agent learns optimal entry/exit/position sizing from raw data. Replace all rule-based exit logic
- **Where**: New `ml-service/app/rl_agent.py`
- **Why**: Theoretical ultimate solution. But needs massive data + training time

### #30 LLM Strategy Generation
- **What**: Claude analyzes performance -> proposes feature/strategy hypotheses -> Optuna validates -> human confirms. Not writing model code, proposing "chip_momentum = foreign_consecutive x vol_ratio might work" -> auto-validate IC
- **Where**: `ml-controller/graphs/strategy_gen_graph.py` (new)
- **Why**: Human can't explore all possible feature combinations. LLM proposes, Optuna validates, human decides

---

## Hardcode Elimination Progress

| Phase | Auto-Learning | Still Hardcode | Intentionally Manual |
|---|---|---|---|
| **Now** | 18% | 72% | 10% |
| **P0 done** | 35% | 55% | 10% |
| **P1 done** | 50% | 40% | 10% |
| **P2 done** | 75% | 15% | 10% |
| **P3 done** | 90% | 0% | 10% |

**Intentionally manual 10%**: Universe filter (strategy assumption), Hard stop -12% (last defense), Fees/tax (real rates), Model replacement confirmation (your decision).

---

## Timeline

```
P0 (Week 1-2)        P1 (Week 3-6)         P2 (Week 7-12)        P3 (3-6mo)
──────────────       ───────────────       ────────────────      ──────────
#1-3 Optuna x3        #8 Model Lifecycle    #16 Weekly AI Audit   #28 GNN
#4 Backtest cron      #9 IC+Hyperparams     #17-18 Red-Blue Army  #29 RL
#5 Monte Carlo        #10 Meta dynamic      #19 RRG Grid          #30 LLM Gen
#6 PBO                #11 LangGraph         #20 CB+Trailing Opt
#7 Sortino/Calmar     #12 Portfolio         #21 MLP Shadow
                      #13 Execution         #22 FT Online Update
                      #14 Injection Det     #23 PTT ML features
                      #15 Observability     #24 Conformal Opt
                                            #25 Screener Percentile
                                            #26 Exit Dynamic
                                            #27 Feature Window Opt

Evolution:  3/10  ->  5/10  ->  8/10  ->  9.5/10
```
