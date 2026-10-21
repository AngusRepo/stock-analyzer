# Codex → Claude 原始碼交接 — 2026-10-21

Wei 指示：完成交接即停手；不再並行修改。部署、整合與後續實作由 Claude 負責。

## 唯一交接分支

- PR：#34，`codex/a-monthly-p6a-20261020`。
- 本次提交前 head：`0d3765eb72e3b46fdb1d263d8655d7fdbe667ffa`。
- 保留 PR 原 base `claude/takeover-integration-20261020`；本次不另做 rebase 或 force push。
- 交接時讀到 origin/main：`8c41913b845b8042a08cd6e936a0b1b9d05307d5`；N 已合併，Claude 風控 WIP 尚在其工作樹。

## 逐檔清單與保存方式

`WORKTREE-FILES.csv`：285 筆來源工作樹／檔案記錄，每筆列用途、是否仍需要、來源 head、兩端 SHA256、處理方式、owner。

- R14：14 份，10 份已包含於本分支，4 份不同版本保存為 patch。
- R17：工作樹乾淨。
- R30：251 份，206 份已包含於本分支，45 份不同版本保存為 patch。
- Claude 風控：12 份原有未提交變更，另存 patch；原工作樹未被修改。
- R33：8 份本機變更直接納入本分支。

已包含者依內容比對（只容許 CRLF/LF 差異）認定。其餘保存為 `r14-unrepresented.patch`、`r30-unrepresented.patch`、`claude-risk-unrepresented.patch`，分別相對 `WORKTREE-SUMMARY.json` 的原 head。**patch 是完整歷史差異保存，不代表應再整包套用，也不代表已經在目前程式中啟用。** 同一檔在不同樹的版本都保留，不以舊版覆蓋新版。

`PR34-COMMITTED-FILES.csv`：本次提交前 PR34 相對 origin/main merge base 的 319 份已提交檔案，逐檔列用途、仍需要與否及最後修改 commit。它不包含本次新增的交接目錄與 8 份 R33 WIP（另見前表）。

R33 已撤回 P6／TabPack、P3 合成器與冠軍／挑戰者／影子帳戶的正式鏈方向；相關檔案保留為歷史及相容證據，禁止把「保存」當成「本次應部署啟用」。原有修補是否仍保留，以逐檔欄位及實際 call path 為準。

## 本次 8 份 R33 原始碼

| 檔案 | 用途 | 仍需要 |
|---|---|---|
| ml-controller/services/l3_equal_weight.py | 固定七模型 rank 平均、缺值 0.5、OOF 線性校準 | 是 |
| ml-controller/services/l3_equal_weight_allocation.py | 直接接既有配置器／成本／持倉契約 | 是 |
| ml-controller/services/l3_equal_weight_bundle.py | 七模型身份、rank pool 與校準 bundle 校驗 | 是 |
| ml-controller/services/l4_distribution.py | 新 schema 的 bundle 驗證分支 | 是，共用入口 |
| ml-controller/services/l4_distribution_runtime.py | 新 schema 直接推論／配置分支 | 是，共用入口 |
| ml-controller/tests/test_l3_equal_weight.py | 配方、缺值與校準測試 | 是 |
| ml-controller/tests/test_l3_equal_weight_allocation.py | 既有配置器橋接測試 | 是 |
| ml-controller/tests/test_l3_equal_weight_runtime.py | 共用 runtime 不呼叫舊 L4 的整合測試 | 是 |

## 驗證與限制

已完成新測試 28 passed、原 bundle/runtime/P6 邊界回歸 33 passed，合計 61 passed，0 failed。收據放在 private 交接包；本次只保存及提交，沒有額外擴大功能測試。

這不代表 R33 已能正式出單：真實 pipeline 七模型 producer、monthly roster／registry、release/admission、歷史 L2 pool 與原九日效能驗收尚未完整接通。沒有正式 release 的 bundle 仍會拒絕，不以本機測試冒充部署收據。

新的測試在原 head 尚不存在；既有邊界測試原樣執行 33 passed。本輪沒有新增失敗可供 main 對照。封存 patch 未套用、未當成另一套可執行 union 進行測試。CI 基礎設施與其他 session 的 main 修補尚未 rebase 進本分支，Claude 整合時須跑 head/base 對照。

沒有部署、重訓、付費推論、production KV/D1 寫入或真實下單。兩個 release JSON 未被手改。

## 下一位 owner

Claude 以本分支與 private 交接包續作；重新確認 main 與 prod，依 R33 完成剩餘接線與部署驗收。舊 patch 按檔審查，不以舊版覆蓋目前 main；兩個 release JSON 由 Claude 發布時重新產生。Codex 交接完成後停止，不保留背景修改或排程。
