# Progress — StockVision

## Session 2026-04-14

### Portfolio
- Total: $904850 (-9.51%)
- Positions: 0 | Cash: $794850
- MDD: 10.6% | Sharpe(30d): -2.2094476657996402

### Today's Pipeline
- Screener: 25 → ML BUY: 0 → T2: 0 orders
- Trades: 0 BUY / 0 SELL

### Positions
No positions.

### Model Health
- Degraded: None
- Optuna params version: latest

### Deployments
- Worker: latest
- ML (Modal): deployed
- Controller (Cloud Run): deployed

### Cron Schedule
```
17:30 data-update → 17:40 screener → 18:00 ml-predict → 18:05 recommendation → 18:35 obsidian
07:15 morning-setup → T2 debate → paper trading
```

### Action Items
- [ ] Monitor pipeline execution

## Session 2026-04-08 Part 2（已結束，進 new session）

### 最後狀態
- **audit Phase 0-4 救急快修完成**（commit 35 files + push + 253 rows DELETE + B1/B11/B12 四 bug fix）
- **Phase 5.1-5.5 D-2 verify pipeline 完整 port 到 ml-controller LangGraph**
- **Token drift P1 bug 修復**：Worker/ml-controller/Modal/settings.json/modal_app.py 五處全部同步為 `sv-stockvision-2026-prod`
- 15/15 cross-runtime parity（Python `_trade_simulator.py` vs Worker `simulateTrade`）
- B6 fire-and-forget bug fix：`runPredictionVerification(env).catch(...)` 從 pipeline cron 移除
- 新 cron `0 11 * * 1-5`（19:00 TW）→ ml-controller `/verify/run` LangGraph pipeline

### Deployments（本 session 最新）
- **Worker**: `fa21a98c-bdc3-43e3-b5ac-06faf1df2d01`（Phase 5.5 cron + trigger + B1 + B6 + simulateTrade export + /api/admin/test/simulate-trade）
- **ml-controller**: `ml-controller-00043-mlk`（Phase 5 verify pipeline + B11 + B12 + token env 同步）
- **ml-service (Modal)**: redeployed 2 次（B12 + 新 token secret pickup）

### 🚧 待繼續（next session 起手）
**Phase 5.6 Dual-run 5 個交易日觀察** — 每天 ~5 min:
- 4/9（週三）19:00 TW = V2 cron 首次自動跑
- 手動 trigger `verify`（V1）對照 V2 cron
- 5 個交易日（4/9-4/15）0 diff → Phase 5.7 砍 V1（593 行 predictionVerifier.ts）

**接續任務 Option A**（推薦）:
1. Phase 5.6 daily check（並行，每天 5 min）
2. **Phase 6 Path 5 RRG vs-benchmark 統一**（~5 hr, 6 sub-phase）
3. 6a.7b screener parity test（~2-3 hr）
4. Sprint 5.1 + audit Phase 7 Layer B/C（~5-7 hr）
5. 6a.8 profile + targeted opt → Sprint 5.2 / 5.3 / 6b / 4-2 revisit / 7+

### Portfolio
- 3045 台灣大 1000 股 @109（4/8 10:23 TW 手動 trigger morning-setup 成交，9 天來第一單，DOWNGRADE 半倉）
- R:R ≈ 0.5（S1 策略問題活案例，vol_pct 0.66% 極窄）

### Cron Schedule（Phase 5.5 新加 19:00）
```
17:30 Worker runFullPipeline (fetch → screener → ml → rec)  [B6 fire-and-forget 移除]
18:20 Adaptive Engine
19:00 ⭐ NEW: D-2 Verify Pipeline V2 (Worker → ml-controller /verify/run LangGraph)
18:25 Daily Report Discord
18:40 Obsidian daily
07:15 Morning Setup
```

### Key Files（本 session 新增/修改）
**新增 (6)**:
- `ml-controller/services/_predictions_schema.py`
- `ml-controller/services/_trade_simulator.py`
- `ml-controller/services/verify_service.py` (~460 行)
- `ml-controller/graphs/verify_pipeline.py`
- `ml-controller/tests/test_simulate_parity.py`
- `worker/src/lib/_predictionsSchema.ts`

**修改 (10)**:
- `worker/src/routes/paper.ts` (B1)
- `worker/src/lib/predictionVerifier.ts` (export)
- `worker/src/index.ts` (+6 處: test endpoint/verify-v2 trigger/19:00 cron/B6 removal)
- `worker/wrangler.toml` (新 cron)
- `ml-controller/services/modal_client.py` (B11)
- `ml-controller/services/payload_builder.py` (B12)
- `ml-controller/graphs/daily_pipeline_v2.py` (B12)
- `ml-controller/routers/verify.py` (新 /verify/run)
- `ml-service/app/ensemble.py` + `ml-service/app/main.py` (B12)
- `ml-service/modal_app.py` (token 註解)

### Action Items（下 session）
- [ ] Phase 5.6 dual-run daily check × 5 天
- [ ] Phase 6 Path 5 RRG vs-benchmark 統一
- [ ] 6a.7b screener parity test
- [ ] Sprint 5.1 + audit Phase 7 L2/SLTP Optuna

### 待解決 tech debt / known issues
- `_predictions_schema.py` constants 尚未接線到 `recommendation_service.py` / `paper.ts`（refactor 時順便）
- ml-service Cloud Run maxScale=2，B11 concurrency=20 可能 inference bottleneck（clean run 後觀察）
- Python 3.14 `asyncio.WindowsSelectorEventLoopPolicy` deprecation（3.16 會壞）
