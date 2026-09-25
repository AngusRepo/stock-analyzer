# 首日 NAV 執行登記接續修補（已批准部署）

## 原因與範圍

9/24 evening chain 已結束，但預先封存、預定 9/29 07:15 台北開始的 ensemble A/B 與 l15_route 登記仍綁定 `aaca5d30…` 引擎。9/25 production 已部署 `d2d75e9d…` 出場行為版。原先 registration reuse 只確認登記存在，沒有檢查執行版本；真正執行時才由精確指紋防護拒絕。

本修補保留原始不可變紀錄，新增「尚未開始的首日接續登記」；不聲稱舊、新 Paper 行為等價，不承接任何 NAV 成熟度。

## 行為

- 只允許 previous_session_date 為空、沒有任何日誌／收據／首格執行，而且仍早於第一格的原始首日登記。
- 完整驗證舊 allocation、角色及環境；新 allocation 只變更 native execution owner 與由此衍生的 configuration/pair identity。
- 選股、模型預測、費率、初始現金、私人 SQL state、來源 context 與日程逐欄保持一致。
- 先封存新 allocation/execution，最後用單筆 immutable succession receipt 同時啟用新登記並退休舊登記。中斷產生的未啟用紀錄不能執行；重試沿用相同身分。
- collector、整日重播、NAV accounting 與 registration reuse 都檢查退休／未啟用狀態。未識別程式版本仍拒絕。
- 每個 comparison 各自原子啟用。兩筆批次先全部預檢；中途故障可逐筆安全重試，並不宣稱跨 D1/GCS 的整批交易。

## 精確變更清單

Learning migration：`0054_native_prestart_successions.sql`，新增一張 immutable mapping 表及三個防覆寫 triggers。同步 domain registry、schema builder、learning bootstrap schema。

命令：`ml-controller/scripts/repair_native_prestart.py`。預設唯讀；輸入必須包含精確 snapshot id 與 payload checksum。`--apply` 另需完全匹配實際引擎的既有 Paper runtime approval。此命令不建立批准、不改 schema、不呼叫 Modal、不改 production 模型。

## 正式目標

| owner | 原始 execution snapshot | 原始 payload checksum |
|---|---|---|
| ensemble A/B | 99e3e788cdfe8b7e9426d6ef22c40044d5977e6cb717f13a8d9aa42195c34e53 | 1ca3c1fc1d2c0c4067e542e6848827ce39bbdc51a8bd8bf1b4684eac02ed62cc |
| l15_route | ea59cd8c051fb31accb11a89fd1c2f0409920ece800a65e91ed77aa8a4318fe8 | ab74e3731c10a4b89f0b80ed6c7221a1fb22af893a54a1e23bcc6b3cb4ee8dee |

2026-09-25 19:49 台北唯讀核對：兩筆皆無歷史 journal／execution receipt／首格 delivery；全部冷物件 SHA 及兩臂初始 SQL state SHA 驗證通過；初始 NAV 均 966,998.13。Migration 尚未存在。完整原始 parent 角色／策略驗證必須由正式 apply 再執行，預檢不可取代。

## 授權後的部署順序

1. 從此隔離分支 review、commit、push；確認來源 SHA 與 production 部署基底沒有其他待合併差異。
2. Learning 只套用 0054，不重建或覆寫其他表。驗證 immutable triggers 與 domain ownership。
3. 建置同一 SHA 的 Worker／controller native bundle；核對精確 runtime fingerprint。部署 Worker 路由與 controller、使用該 native runtime 的 Cloud Run Jobs；不部署 Modal 或重跑前段 evening chain。
4. 原 Paper admission 保留；準備並發布「只有 execution_owner_version 更新」的精確 runtime approval，核對完整配置無額外改動。這是新版本批准，不是 source-equivalence。
5. 在相同部署 image 中執行唯讀 plan；再次確認兩筆 checksum、未開始狀態及第一格截止時間。確認 plan 後使用同一 targets、expected-owner 執行 `--apply`。
6. 回讀每個新 allocation/execution/receipt，確認精確 owner、保留內容及初始狀態、只有 successor 被派送及 lifecycle 選用；查看正式 NAV/API 的角色標籤與 pending session。不得人造 9/29 的歷史格或提前給成熟度。

## 回滾界線

啟用 receipt 前，可還原 controller/job/Worker revision 與 runtime approval；原始登記未被修改。啟用後不得刪除 receipt 或假裝原登記仍有效；舊程式不認識 receipt，不可單獨回滾到舊 collector。若新版有問題，先暫停這個 private paired collector，再修正保持 mapping 防護的版本。此首日修補只支援一次接續，後續版本改動需另行處理，不能反覆重新起算 NAV。

## 驗證與限制

本機測試含 owner mismatch、完整歷史/初始 state 保留、越界時間、已有執行拒絕、重算 checksum 仍無法竄改、發布中斷恢復、未啟用及退休入口阻擋、單一 successor 派送、原生雙臂完整 session 與 NAV 單次入帳。測試結果見本次 audit。

第一筆 9/29 NAV 仍需當日來源與 281 格雙臂執行完成，最後 snapshot 約 14:20；本機通過不能證明未來無 provider 故障。正式尚未部署或寫入接續資料。

Raw evidence: repository-root `audits/nav-first-session-check-20260925/READINESS.md` and `audits/native-prestart-repair-20260925/{production-preflight.json,targets.json,tests.xml}`.

## 本次授權

Wei 於 2026-09-25 明確批准本清單的 commit／push／deploy、精確 Paper runtime approval 及兩筆接續修復；來源與初始資金保留，不重跑前段、不使用 Modal。

## 切換前實測發現的效能缺口

完整原始輸入預檢於 8 GiB 一次性 Job 成功，峰值 RSS 5431.3 MiB；另以日常 controller 的 4 GiB 規格執行比較讀取，Cloud Run 明確回報 configured memory limit was reached。父資料 858,026,591 bytes 已完成讀取，後續角色驗證仍深複製完整雙臂輸入，但比較讀取未使用回傳副本。修補讓此唯讀驗證保留全部檢查、跳過不使用的複製；接續驗證沿用同次完整驗證的比較結果，避免再下載及解析同一個大父資料。建模／執行需要副本的既有呼叫仍預設複製。部署前須重測 4 GiB 日常路徑；未移轉 maturity，未宣告 source equivalence。

日常 tick 入口也改為同一 session 的進行中請求共用一次執行；controller concurrency=40 時，跨分鐘重疊請求不再於同一程序重複載入大父資料。HTTP 等待者中斷不會取消 checkpoint writer；執行完成或失敗後清除，只共用進行中的工作、不缓存永久成功。
