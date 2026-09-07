# Artifact lifecycle 收斂：本機修補與驗證

日期：2026-09-07。Base commit：127d1867。工作樹：codex_ev_fix_wt。
尚未 commit / push / deploy；未觸發正式 retrain、promotion 或修改正式資料。

## 本次變更

1. **每日成熟資料驅動正式 cohort**
   - Worker daily 進入同一 input-deduplicated release factory。
   - 依實體 OOF 日期、相容語義與既有 5-fold parent 判斷；新增滿 10 個不同成熟日期才擴窗，不靠星期幾。
   - 沿用 parent/resume_manifest 與原 60/10 window，未減低 gate、未換 L4 模型或權責。
   - 不足 10 日仍做 frozen forward evidence；formal full-fit 對既有 cohort 查詢/續跑 identity-bound receipt，不把 forward shadow 用來訓練。
   - full-fit 等待時仍物化每日 L4 evidence，但整體 closure 保持 pending。
   - daily pending/spawned callback 為 triggered 而非 skipped；綁定 exact cohort，未就緒時等待原本的 manifest。
   - daily exact continuation 保留模型 producer identity，但使用最新合法 prep 的成熟 watermark；weekly/monthly 的 exact continuation 保持既有 frozen prep。
   - pre-dispatch fast path 先檢查是否有新完整批次，不能讓既有 terminal receipt 吞掉新 cohort。
   - lifecycle receipt 升 v14；只影響工作完成收據，不重置模型、候選或已成熟 evidence。

2. **Optuna consumer 分組及真實 closure**
   - selection：signal / screener / rrg / alpha_framework。
   - execution_risk：sltp / risk_params，保留重疊出場與風控欄位的聯合驗證。
   - label_uncertainty：barrier / conformal。
   - GA 維持既有獨立 staging；不改 GA promotion gate。
   - 每組沿用 research_sweep sandbox 與完整 candidate-specific validation，不新增正式 promotion owner。
   - 缺來源只擋該組，failed/blocked source 不再被包裝為 success。
   - 外層 partial 不再報 completed；即使其他組失敗，callback 仍帶出所有成功 candidate_ids 啟動驗證。
   - 同一 Cloud Run job 的 bounded retry 重用已成功 source results，不反覆搜尋與改寫成功候選。

3. **候選重送去重與成熟狀態保留**
   - sandbox ID 包含完整 config、source、group 與 run identity 的 SHA-256；相同 run/內容重試重用同一 sandbox，index 去重。
   - 註冊時寫入 configHash；同 sandbox/hash 重送不把既有 PROMOTION_READY 等狀態降回 SHADOW_COLLECTING，保留 evidence/promotion packet。
   - 無可靠輸入證據的不同 research run 不強行合併；不同資料或 config 不覆蓋舊候選。
   - 歷史 5 月重複紀錄與舊 GA records 未刪除／合併：當時 input/evaluator lineage 未足以證明等價，不能只看 configHash 就破壞歷史。

4. **舊入口整理**
   - 移除確認無 production caller 的 runWeeklyRetrain generic wrapper 與 re-export。
   - 保留有 admin caller 的 drift/direct-refresh 研究入口及其禁止直接 promotion 的保護，不假裝它們是正式排程。

## 驗證

- Python：205 passed（OOF、Active8 ensemble、Optuna、parameter validation、weekly closure）。
- Worker：13 passed（5 個 test files，含 scheduler contract、daily preflight、sandbox identity、group merge）。
- TypeScript：tsconfig.json 與 tsconfig.tests.json 均通過。
- git diff --check 通過。
- 測試使用 mock GCS/KV、mock training calls、in-memory SQLite；無正式資料寫入。
- 新測試覆盖 9/10 日邊界、三種 cadence 同 factory、PIT 語義不相容、重複日期不計數、exact cohort 等待、daily watermark 不倒退、release pending 不阻擋每日證據、partial callback 候選不遺失、成功搜尋不重跑、候選 SQL 狀態保留。

## 變更檔案（本次；不等於 worktree 全部 dirty files）

- ml-controller/routers/walk_forward.py
- ml-controller/oof_materialize_job_main.py
- ml-controller/routers/optuna.py
- ml-controller/optuna_job_main.py
- ml-controller/tests/test_artifact_data_ready_lifecycle.py（新增）
- ml-controller/tests/test_optuna_alpha_framework_route.py
- ml-controller/tests/test_oof_lifecycle_lineage_v4.py
- worker/src/lib/controllerResearchWorkflows.ts
- worker/src/lib/controllerWorkflows.ts
- worker/src/lib/optunaConfigMerge.ts
- worker/src/lib/tradingConfig.ts
- worker/src/lib/parameterCandidateRegistry.ts
- worker/src/lib/artifactCandidateIdentity.test.ts（新增）
- worker/src/lib/active8OofSchedulerClosureContract.test.ts
- worker/src/routes/adminControlRoutes.ts
- worker/src/routes/adminOptunaRoutes.ts

此前未部署的 monthly automation 修補保留，重疊檔案在既有修改上增補；主目錄 unrelated changes 未碰。

## 部署後才可驗證的事項

- 本地 mock 測試不代表正式 automation 已完成；需另獲 commit/push/deploy 授權。
- 依既有 provenance 流程對齊 Worker/controller/jobs 與必要的 Modal release；不可只換 Worker flag。
- 確認正式 daily 用最新 prep 計出 9→10 日期進展，建立新 cohort、沿用父 folds、完成 full-fit/ensemble validation 與 terminal callback。
- 新 cohort 資料不足或績效 gate FAIL 仍不得移動 serving pointer；滿 10 日不保證 ensemble 通過。
- 首次上線要檢查當日舊 snapshot terminal ticket 是否已結束；若需要補跑，只重開指定當日工作，不清空歷史成熟 evidence。
- 正式 Optuna 首次執行時核對三組 candidate_ids / sandbox readback / validation callback；不手動 bypass promotion。

## 記憶來源

Obsidian recall receipt:
- query: artifact cadence overdesign daily cohort Optuna candidate identity
- status: found
- answer_policy: cite_wiki_hits
- citations:
  - 02_Products/StockVision/Sessions/2026-09-07-2026-09-07-artifact-cadence-and-overdesign-read-only-audit.draft.md

FinLab 技能影響：維持 PIT / label-known / 成熟證據隔離，不把歷史研究或尚未成熟報酬改作前瞻通過證據。
