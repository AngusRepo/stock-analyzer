# Progress — StockVision

## Session 2026-05-11

### Portfolio
- Total: $1005316 (0.53%)
- Positions: 0 | Cash: $1002159
- MDD: 11.5% | Sharpe(30d): 0.39840838026112807

### Today's Pipeline
- Screener: 64 → ML BUY: 3 → T2: 0 orders
- Trades: 0 BUY / 1 SELL

### Positions
No positions.

### Model Health
- Degraded: DLinear(IC=-0.030231)
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
# 2026-08-07 Fusion v13 lineage closure

- 建立隔離分支 `codex/fusion-v13-lineage-closure-20260807`，避免覆蓋主 worktree 未提交變更。
- 完成 Obsidian recall、repo contract 與 production read-only audit。
- 已確認 v12 serving baseline / v13 candidate 的版本錯配、sector 第一合法日期 freshness gap、maturity evidence scope 混用、replay lifecycle sticky telemetry 四個 root causes。
- 下一步：實作 migration/evaluator/API/UI/orchestrator 修補並驗證。
- 8/7 production packet 已證明 7/30 sector lineage 自動納入：Fusion/L4 均為 513 samples / 1 date；sector freshness root cause closure 完成。
- 完成 v13 baseline contract 設計：同版雙 head 零交易 control，並將 no-trade LCB 與 canonical L4 paired comparison 明確分層。
- 已完成 code/migration/UI/replay patch；另修正 frozen-forward quality 被 policy 強制覆寫為 FAIL 的 root cause。
- 進入 targeted tests、typecheck/build 與 migration dry-run audit。
- Targeted worker 7/7、Python 56/56、worker typecheck、frontend build 已通過；migration audit 改用 fresh isolated D1 state。
- Legacy/learning migrations 均通過 fresh DB、idempotent replay 與 pointer/payload v13 query；開始 production handoff。
