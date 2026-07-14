# Multi-LLM Strategy Discovery & Adversarial Audit Lab — Phase 0

## Goal

依照 2026-07-10 已確認規格，先完成 Phase 0：核對 repository 現況，產出可直接進入實作的架構、資料模型、Workflow、模型呼叫、Neuron 預算、Codex Skill 與測試設計。此階段不部署、不修改正式交易流程、不呼叫 OpenAI API。

## Scope

- 頁面只保留兩個主要操作：`完整分析`、`Codex 結論`。
- Cloudflare Workers AI 負責 discovery、red team、cross examination。
- Codex App 由使用者手動呼叫 repo skill，負責 repository evidence 與 executable tests。
- 搜尋政策固定為 `6C + 4B + 2D + 0A`。
- 先完成 Phase 0 文件；不得直接進入 Phase 1 實作。

## Phases

- [in_progress] 0.1：Obsidian recall、repo/branch/dirty tree 與既有架構盤點
- [pending] 0.2：核對 Cloudflare 官方能力、模型可用性與計費假設
- [pending] 0.3：形成架構決策、資料流、D1/R2 分工與 Workflow
- [pending] 0.4：形成模型呼叫、預算、Codex Skill、測試與里程碑設計
- [pending] 0.5：寫入 Phase 0 deliverables 並執行文件一致性檢查

## Constraints

- 不 deploy、commit、push、retrain。
- 不修改 StockVision 正式流程或交易程式。
- 不加入 OpenAI SDK/API key；Cloudflare 不自動啟動 Codex。
- 保留既有 dirty worktree 與根目錄另一項任務的 planning files。
- 任何時效性 Cloudflare 資訊以官方文件為準。
- 任何過去決策以 Obsidian recall receipt 為準。

## Deliverables

- Repository 現況分析
- Architecture Decision Record
- Folder Structure
- D1 Schema
- Workflow Diagram
- Model Call Plan
- Neuron Budget Plan
- Codex Skill Design
- Testing Strategy
- Implementation Milestones

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| 根目錄 planning files 已屬另一個進行中任務 | 1 | 使用 `docs/plans/strategy-discovery-audit-lab/` 隔離本任務規劃 |
| `session-catchup.py` 經 venv uv trampoline 啟動失敗（permission denied） | 1 | 改以 escalated read-only 執行；git 狀態分開查詢 |
