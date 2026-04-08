# Progress — StockVision

## Session 2026-04-07 (compacted, new session 即將開始)

### 最後狀態
- 5-agent audit 完成（chaos/code/arch/ML/finance）
- C1-C4 + H1-H9 + M1-M2 全部修完並部署
- Worker `twToday2` 初始化 bug 已修（刪除 duplicate `const twDate`）
- Holiday KV 已驗證 7 個邊界（含 4/4 清明、10/10、12/25、2/15）
- Obsidian Second Brain 已上線（AngusRepo/Angus-brain）
- 47 hardcode params → KV migration done
- SHAP (#31) / Regime Optuna (#32) / RL Shadow (#29) / GNN Shadow (#28) 都完成

### 🔴 待繼續（next session 第一件事）
**LangGraph 架構問題** — User 已說 `go`，還沒執行：

根本原因：Controller 繞 Controller→Worker→Controller→Modal 4 層 HTTP，每層加延遲 → 超過 Cloud Run 300s timeout，被迫加到 600s 會增加成本。

修復計畫（改動很小）：
1. `worker/src/index.ts` line 1674 `cron === '30 9 * * 1-5'` 分支
   - 現在：line 1689 `postController(env, '/pipeline/run', ...)` 600_000ms timeout
   - 改成：直接跑 Worker 內建 `pipeline` task（taskMap line ~348，已有 await gate）
2. `gcloud run services update ml-controller --region=asia-east1 --timeout=300` 還原 timeout
3. （選配）在 Worker pipeline 加 KV checkpoint pattern
4. Deploy Worker + verify

Worker 自己跑只有 1 層 HTTP（ML predict → Modal），快很多。

### Portfolio
- 無 active positions
- Paper trading running

### Deployments
- Worker: latest（twToday2 bug 已修）
- ML (Modal): deployed（FTTransformer 已還原）
- Controller (Cloud Run): timeout 600s（待還原 300s）
- Obsidian: AngusRepo/Angus-brain 運行中

### Cron Schedule（當前，待改）
```
17:30 Controller /pipeline/run  ← 要改成 Worker 自己跑
18:40 Obsidian daily push
07:15 morning-setup
```

### Key Files
- `worker/src/index.ts` line 1674, 1689（cron handler）
- `worker/src/lib/dateUtils.ts`（twToday/twNow/twDaysAgo）
- `worker/src/lib/tradingConfig.ts`（47 KV params）
- `ml-service/app/features/__init__.py`（C1 ATR raw）
- `ml-service/app/models.py`（SHAP + FTTransformer restored）
- `ml-controller/services/obsidian_writer.py`

### Action Items
- [ ] 改 cron 17:30 → Worker 內建 pipeline task
- [ ] Cloud Run timeout 600s → 300s
- [ ] Deploy + verify <300s
