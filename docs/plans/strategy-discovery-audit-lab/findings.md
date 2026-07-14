# Phase 0 Findings

## Initial Context

- 使用者提供的對話最後定案為兩個主要 UI 操作：`完整分析` 與 `Codex 結論`。
- 最新規格要求先只完成 Phase 0，再進入 Phase 1–8。
- 根目錄既有 planning files 屬於 allocator EV snapshot backfill repair，必須保留。

## Verified Findings

- 目前分支為 `main`，HEAD `c0784277`；working tree 已有大量 unrelated modified/untracked changes。
- 主要 unrelated modified files 集中於 allocator EV fusion/backfill 與 Worker scheduler；本任務不得觸碰或回退。
- 根目錄 `docs/` 已為 untracked 範圍，因此 Phase 0 文件必須使用明確專屬子目錄，避免混淆。
- `session-catchup.py` 在 sandbox 內因 uv trampoline permission denied；核准後 read-only 執行成功，沒有輸出額外待同步脈絡。
- Obsidian recall status 為 `found`；後續必須讀取並引用相關 notes。

## Obsidian Memory Findings

- `02_Products/StockVision/Sessions/2026-05-16-v4-canonical-feature-contract-and-finlab-feature-lake-sidecar.draft.md`：production canonical contract 曾固定為 `ml-service.app.features.FEATURE_COLS`、106 features；FinLab sidecar 15 families／2411 fields 均為 research/shadow-only，不可直接進 ML、pending-buy 或正式交易。
- `02_Products/StockVision/Sessions/2026-05-31-finlab-ai-skill-discovery-lane-correction.draft.md`：discovery lane 可保存 research candidates，但 `maxMlShare=0`；生成策略必須成為獨立 validated strategy spec 並通過 promotion approval，才可進正式路徑。
- `02_Products/StockVision/Sessions/2026-06-18-stockvision-attached-feature-registry-roadmap-audit-p0-p13.draft.md`：Feature Registry／promotion contracts／preflight gates 已有大量既有 tooling；production mutation、feature activation、retrain/release 均刻意 fail-closed。月度 strategy mining runtime 當時仍未完整閉環。
- `02_Products/StockVision/Sessions/2026-06-21-stockvision-formal137-strategy-evidence-fail-closed-local-repair.draft.md`：策略 feature evidence 必須 fail-closed；positive-weight refs 不可缺漏或以 null 當 0，normalized alias contract 不能繞過。
- `02_Products/StockVision/Sessions/2026-06-26-stockvision-active11-strategy-pool-rotation-and-pairwise-audit.draft.md`：當時 active=11、candidate=12，並已有 pairwise corr+jaccard/overlap audit；不能假定「13 套」仍是 runtime 真值。
- `02_Products/StockVision/Sessions/2026-06-01-stockvision-finlabai-production-diversity-strategy-expansion.draft.md`：策略多樣性擴充曾使用 raw factor/technical mining，但 discovery strategy 本身仍保持 research-only。

## Architectural Implications

- 新 Lab 應讀取既有 registry/export/validator 產物，不另造一套與 StockVision source-of-truth 競爭的 Feature/Strategy registry。
- 「13 套策略」應成為 user-selected/frozen snapshot 的期望值或顯示值，不應在 domain schema 硬編碼；preflight 要顯示實際 active/candidate counts 與 snapshot source。
- Candidate generation、Cloud analysis 與 Codex verdict 全部維持 research-only；promotion、retrain、deployment、pending-buy、live execution 明確在本系統之外。
- 既有 pairwise correlation/Jaccard、feature ref validator、promotion preflight、research ledger 應優先重用。
- 最新 wiki 命中 `02_Products/StockVision/Sessions/2026-07-01-stockvision-2026-06-30-evening-chain-recovery-and-active12-governance-closure.draft.md`：已驗證 production active strategy count=12，active attribution=12，且有 `current_active_12_strategy_specs.json` source artifact。
- `02_Products/StockVision/Sessions/2026-06-30-stockvision-final-active12-strategy-promotion-local-closure.draft.md`：Active12 決策是策略治理結果，仍保留 research/candidate pool；5 套舊 adapter 當時為 unsupported，不應把 active count 當成「全部可直接由 Lab numerical runner 重跑」。
- 因此 Phase 0 應把最新 verified baseline 寫成 `12 active strategies`，同時允許使用者匯入明確 frozen strategy snapshot；對話中的「13 套」不再視為可信 runtime 常數。

## Open Questions

- 此獨立 lab 應放在現有 Worker app、獨立 Worker package，或 repo 內新 workspace；需依 repo 現況決定。
- 現有 Feature Pool、13 套策略與 numerical runner 的真實 source of truth 尚待盤點。
- Cloudflare Workers AI 模型 ID、JSON structured output、Workflows、D1/R2 免費配額與 Neuron 費率需以官方文件重新核對。
