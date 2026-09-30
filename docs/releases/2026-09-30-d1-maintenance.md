# D1 維護收據與掃描範圍修補 — 2026-09-30

## 狀態與基底

本次為已批准的 Worker 修補。基底 main 為 `4ea12aaf94d5bbd71938a0ee93756133926562e1`，保留 `5b24a387` 的 NAV / Learning0059 及其後 pipeline recovery 變更；正式發布結果以精確 CI 與 production readback 為準。

原 native record 是 `native-paper-v1:4625d891394904b5081cee9c431df4d8b79a2e35001914754cef65663da43be6`；新增表 ownership 使 source identity 成為 `native-paper-v1:1cc6a100af765c6c8b9b8f98d23d475a92b94604756b269d4c7bf6de947e96ac`。Wei 於 2026-09-30 明確批准此精確指紋，限定全部檢查通過後發布；record 已依授權更新。整合最新 4ea12aaf 後實際重建仍為同一批准值。維護修補的兩個 source 模組均不在 native bundle inputs。

## Root causes 與修補

1. 維護 lease 未取得時的 `maintenance_lease_busy:` 被共用分類器落入預設 success。現在記為 skipped，保留原因與 lease owner；不執行未取得 lease 的工作。
2. 自然 audit drain 的 960 筆 dataset receipts 中，630 次為空目標檢查。下一批現在讀取同 cycle 前一成功 chunk 的持久收據，只繼續有 backlog 的 targets；原 message 保留完整授權範圍。子集合完成後必須全範圍復核才可成功，失敗重試／舊 receipt 回到完整範圍。完整復核仍消耗原成本預算；預算不足仍 error。
3. main Learning0059 新表 `paired_nav_unobserved_pairs_v1` 遺漏 registry ownership，使 P9 回報 `unowned_data_domain_tables`。補登 Learning / full_scalar / route_ready，並驗證 routing 與 legacy shadow backfill 不誤納入。

沒有調整 RAM / CPU、240 次預算、排程、保留天數、每表 bytes 上限、R2 校驗或完整原值 CAS。沒有授予 Cold deletion、Paper runtime admission、等價認證、成熟度轉移或 successor 權限。不包含 Cloud Run / Modal 發布。

## 本地驗證

- 真 SQLite 維護 lifecycle 22 / 22；既有 scheduler status 測試入口通過。
- 覆蓋 lease contention、跨日、重送、最終全查、預算耗盡、legacy receipt、縮小範圍失敗重試。
- Registry / shadow backfill / drain / ancestors 四個相關測試入口通過。
- Worker source/tests TypeScript 通過；`git diff --check` 通過。
- 指定範圍獨立審查沒有剩餘 P1/P2。
- 完整配置 P9 已在批准的新 record 通過：Worker 契約、441 項 Controller 測試、frontend build、diff hygiene 與 secret scan。沿用 CI 的 `SkipBugHunter`；需要獨立 server/model runtime 的兩支 E2E 按原設定另行 gated，本次未執行。

## 發布前必要步驟

source-build record 已依精確授權更新，保留不具等價／成熟度轉移的設定。完整本地 gate、精確 commit CI 與最新 main / live version 防覆蓋檢查必須通過，才依既有條件授權發布 Worker。發布後再讀回 source / version / bindings / scheduler manifest。

## 正式成效與限制

前版自然清理已完成 archive = scrub 52,125 rows，OPS 期間淨減少 205,893,632 bytes；Learning 同期增加 113,225,728 bytes。240 個 chunks 成功，但 root ticket 因 backlog 未清空且預算耗盡而 error。這不是整體十年容量閉環完成，也不能把歸檔 bytes 當帳單節省。

Raw evidence 與精確 identity 隔離重建位於 root checkout `audits/d1-capacity-truth-20260929/`。本次候選沒有手動重跑正式 drain。
