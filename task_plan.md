# Fusion v13 lineage closure plan

## Goal

修復 Fusion/L4 maturity 與 production serving 的證據契約：建立同版本 v13 abstention baseline、恢復合法 PIT sector-alpha lineage 自動銜接、拆開 serving/candidate/shadow evidence，並修正 S12 replay lifecycle sticky telemetry，完成測試、部署與 production audit。

## Safety boundaries

- 不放寬 forecast/economic/PIT/walk-forward gate。
- 不 retrain、不 full-fit、不 promotion alpha candidate、不下單。
- v13 baseline 僅為 fail-closed/no-trade safety owner，不取得 primary expected-return 權限。
- 不回填在 decision cutoff 後才可得的 sector 資料。
- 僅修改本隔離 clone，保留主 worktree 的所有未提交變更。

## Phases

1. [completed] 驗證 production truth、契約差異、合法 sector 日期與 replay lifecycle root cause。
2. [completed] 實作 v13 baseline migration、serving evaluator 與證據 scope 修復。
3. [completed] 修正 sector freshness/lineage 與 replay lifecycle automation。
4. [completed] 執行 targeted tests、typecheck/build 與 migration contract audit。
5. [in_progress] commit、push、部署、production migration/canary/audit、Obsidian handoff。

## Decisions

- v12 baseline 不再作為 v13 serving contract 的現役比較物；保留為歷史 artifact。
- 新 baseline 必須使用 v13 contract、相同兩個 policy-value heads 與相同 feature/label contract，但兩個 head 都是明確 constant abstention/no-trade control。
- baseline 的 operational safety 與 alpha/economic quality分開；不得把 abstention baseline 當成已通過 alpha gate。
- maturity API/UI 分別呈現 serving owner、offline candidate、latest frozen-forward shadow，不再混成同一組 blockers/日期。
- sector-alpha 只接受 decision cutoff 當時已可得的 native PIT lineage；第一個合法日期應由排程自動納入，不以事後回填偽造成熟度。

## Errors encountered

- Codex `apply_patch` 對既有檔案套 Windows sandbox ACL 時失敗；新增檔案正常、更新任何既有檔案失敗。
- 改用相同 Codex `--codex-run-as-apply-patch` engine 的本機可執行副本，不改用 shell 直接覆寫。
- linked-worktree 與 `C:\tmp` clone 都保留未提交狀態；正式修改只在 workspace 內完整隔離 clone。
- Windows PowerShell 5 會吞 native argv 內的雙引號；Python/TSX patch 以 `"` native argument escape 後仍由 Codex patch engine 套用。
- Wrangler 預設 local D1 ledger 顯示 0000–0058 已套用，但實體 DB 缺 `model_artifact_registry`；這是共用 local state 漂移。migration audit 改用全新 `--persist-to`，不把此失敗歸因於 0104 SQL。
