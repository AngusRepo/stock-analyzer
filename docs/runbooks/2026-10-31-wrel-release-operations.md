# W-REL release 營運 runbook（r31 之後第一個 Worker release）

適用範圍：W-REL 各 branch（`wrel/*`）合併部署之後的排程、告警與 fail-closed 行為。時間一律 TW（Asia/Taipei），括號內為 manifest 用的 UTC cron。

## 1. Scheduler sync（需要 Wei 另外 go）

`infra/gcp-scheduler-jobs.json` 屬於 SHARED deploy unit（`tools/deploy_units.py`：worker＋pages）。repo 裡的 manifest 改了以後，live GCP 排程**不會**自動跟著改，要另外 sync：

| job | 舊值 | 新值 | 來源項目 | 順序與期限 |
|---|---|---|---|---|
| `eod-exit` | `25 5 * * 1-5`（13:25） | `20 5 * * 1-5`（13:20） | AUD-4 | **必須在 Worker 部署之後**；下一個交易日 13:20 前 |
| `evening-chain` | `0 13 * * 1-5`（21:00） | `45 13 * * 1-5`（21:45） | C28-25（Wei 10/29） | 和 Worker 部署順序不限（ticket 不比對 cron），建議和 eod-exit 同批；下一個交易日 21:45 前 |

- **eod-exit 不可以早於 Worker 部署**。舊 Worker 的出場時窗是 13:25–13:35；13:20 觸發會回 `SKIPPED`，而且不會告警，當天就沒有收盤出場。
- **只動這兩個 job，用 gcloud 逐一更新**，`--schedule` 和 `--description` 要一起帶（description 要和 manifest 一字不差）：
  - `gcloud scheduler jobs update http eod-exit --location=asia-east1 --schedule="20 5 * * 1-5" --description="<manifest 的 description>"`
  - `gcloud scheduler jobs update http evening-chain --location=asia-east1 --schedule="45 13 * * 1-5" --description="<manifest 的 description>"`
  - 寫完用 `gcloud scheduler jobs describe <job> --location=asia-east1` 讀回 `schedule`、`description`、`timeZone`（UTC）。
- **不要用 `scripts/sync_gcp_scheduler.ps1`**：它沒有單一 job 的參數，會把整份 manifest 套到 live（`-DeleteStale` 還會刪 job）。
- **sync 之前不要跑 auth 輪替**：`scripts/auth_rotation_scheduler_rest.ps1` 會依 manifest 把 live 的 schedule／description 一起 patch 回去，等於沒經過 go 就 sync 了全部 job。
- Worker 端沒有 live 排程的 parity drift 報告，manifest 和 live 不一致時不會自動告警；讀回只能靠上面的 describe。
- 如果 Worker 已經部署，但 `evening-chain` 還停在 21:00：21:00 的 root 照舊會跑，下游也照舊是 event-driven，所以不會壞，只是 FinLab 第一次抓取比較早，late lane 比較容易進入 waiting。

## 2. 晚間時序（evening-chain 21:45 之後）

- 21:45 root：FinLab daily refresh（約 25 分）→ update → indicator → screener → strategy-decision-prefill。10/28 實測：手動從 21:46 開始，FinLab 22:13、update 22:21、indicator 22:24、screener 22:47、prefill 22:53。pipeline／ml／recommendation 隔天 07:15 由 `morning-setup` event-driven 觸發。
- 融資融券（`margin_balance`／`short_balance`）通常在 21:40–22:00 公布。21:45 的第一次抓取仍然可能拿不到；這時 callback 會記 `waiting`（不告警），由 `finlab-backfill-watchdog` 每 10 分鐘檢查、stale 15 分鐘就重送，同一個 run_id、`dispatch_attempt+1`。
- 截止：`data/finlab_source_contract.json` `chip_diversity.late_publication.retry_cutoff_tw` = 23:00（本次不改，見 §6）。23:00 以後不再送出新的 attempt；之前已送出的可以跑完。controller 的 `dispatch_attempt` 上限是 5。
  - root 晚 45 分鐘、cutoff 不變，等於 late lane 的重試時間從約 2 小時縮成約 1 小時 15 分。Modal fail-fast 上線之前，一次 not-ready 的 attempt 約 12 分（10/28 實測）＋stale 15 分＋watchdog tick 間隔，**大約只剩 3 次 attempt**（約 21:45、22:20、22:50；原本約 4 次）。
  - **Wei 10/29 決定：cutoff 維持 23:00，不改。** 以後若要延後，限制如下：
    - 硬上限是 `finlab-backfill-watchdog` 當天最後一個 tick 23:50；cutoff 超過它，watchdog 就不會判定 cutoff 失敗。
    - cutoff ≤ 23:20 時，NEW-86 的告警時間（cutoff＋30 分）仍在 screener watchdog 當晚最後一個 tick（23:50）之內。超過 23:20 時告警不會遺失，會在午夜後的 tick 以前一個營業日補發，但 chain 仍在跑時就不會再延後。
- 正常情況 screener 約 22:47 完成；最晚的情況（22:5x 送出的 attempt 約 23:20 完成）screener 約 23:45–00:10 完成（10/27 實測 00:01）。
- 隔天早上：`morning-setup` 07:15、`premarket-evidence-watchdog` 07:00–08:50。最晚 00:10 完成的情況下，到 07:00 還有約 6 小時 50 分。
- 21:00–21:45 之間，finlab／screener／indicator watchdog 的 tick 會回 `skipped`／no pending，屬正常。allocator watchdog 依最新的 lifecycle 決定 business date，這段時間可能在處理前一天的回復工作，和 root 無關。
- **PIT K(t) 不改（Wei 10/29 決定）**：PIT 可用性合約（`data/feature_registry/pit_availability_contract_v1.json`，branch `r33/pit-cert`）的錨點 K(t) 是「session t 的 21:00 serving capture seal」。root 改到 21:45 只會讓實際 capture 更晚，K(t) 仍早於實際 capture，訓練端不會用到 21:00 之後才有的資料，屬保守方向；`r33/pit-cert` 的程式也沒有用時鐘比對 K(t)。舊排程下 late lane 本來就會在 21:00–23:00 之間 capture，這種「錨點早於實際 capture」的情況不是這次才有。合約描述文字是否要更新，由 C28-02 owner 另外處理。

### 首晚讀回（部署後第一個交易日）

- 觀察窗：21:45–00:10。
- 21:45：`evening-chain` root 觸發；21:45 前沒有 root run_id。
- 約 21:57–22:15：FinLab 第一次 attempt 完成，或記 `waiting`（not-ready 約 12 分就回來）。
- 約 22:20–22:30：若 waiting，watchdog 送出 attempt 2（同 run_id，`dispatch_attempt=2`）。
- screener 完成：正常約 22:47；late lane 最晚約 00:10。23:00 之後沒有新的 attempt。
- 隔天 07:15：`morning-setup` 觸發 pipeline／recommendation。

## 3. 告警與人工處理

- **FinLab late lane**
  - 23:00 cutoff 失敗時，`finlab-v4-backfill` 和 `evening-chain` 各告警一則，`update` 記 `blocked`。兩條路徑的時間不同：
    - watchdog 判定：兩則同時發出。
    - 23:00 之前送出、callback 在 23:00 之後才回來仍然缺資料：callback 當下先發 `evening-chain` 一則；下一個 finlab watchdog tick（最多晚 10 分鐘、≤23:50）再發 `finlab-v4-backfill` 一則。
  - watchdog 重送時，非 HTML 的 4xx／5xx（包括重試用盡的 "no available instance"）視為 dispatch 確定失敗，會立即告警一則，`update` 記 `blocked`。HTML 5xx 視為 `dispatch_unconfirmed`，交給下一個 watchdog tick。
- **Screener 沒跑（NEW-86）**：23:30（cutoff＋30 分）告警；如果 evening-chain 仍在 waiting／running／triggered，延到 23:50（screener watchdog 當晚最後一個 tick）。
- **手動重跑**
  - 同一天同一個 task 只會告警一次（dedup key `cron:alert:${task}:${date}`）。所以 cutoff 之後手動重跑又失敗，**不會再告警**，要自己看 OBS。
  - evening-chain 處於 late-lane `waiting`（23:00 前）時，非 force 的 root 或手動觸發會回 `running: … late_lane_owner=finlab_watchdog`，不會蓋掉 waiting 紀錄。真的要重來就用 force（新的 run_id，舊 attempt 會被 fence 擋掉）。
  - 23:00 以後，非 force 的人工重啟不會再被 waiting 擋下。截止後只告警並停住，不會自動改用 d-1 融資（C28-25 Q6）；人工重啟仍要 Wei go。

## 4. Paper fail-closed 串接

- **P8（AUD-21）**
  - 新買的基準是前一個 session 的 `paper_daily_snapshots`。缺少或無效 → 當天擋新買（`p8_fail_closed`），出場不受影響。
  - 例外：帳戶沒有任何 snapshot，而且在當天（TW）以前沒有任何 order，才用 `initial_cash` 當基準。當天自己的成交不影響這個判定。
- **臨時休市**（颱風等）
  - 必須補寫 `holiday:YYYY-MM-DD`。否則隔天的 previousSession 會是那一天，因為沒有 snapshot，整天都會擋新買。
  - 補寫屬於 KV 寫入，要 Wei go，寫完要讀回。
- **前一天 snapshot pending → 隔天 P8 擋新買**：這是 AUD-20／O04 和 AUD-21 接在一起的預期效果，不是 bug。
- **收盤 snapshot 的價格日期檢查（O04）**：每一筆持股的 mark 都必須是該 valuation session 的價格，可以是 session 精確收盤，或報價時間落在該 session 的 post-close quote。權利股標的（應收股、認購權）不在檢查範圍（Wei 10/29 決定）。
  - `paper_snapshot_mark_date_mismatch:<session>:<symbol>@<price_date>`：source 回來的價格是別天的（stale），或是 quote 時間證明不了日期（undated）。snapshot 不寫入，並記一筆 `snapshot_audit`／`pending_valuation`，detail 裡有 `mark_issues`、`rejected_quotes`。
  - `paper_snapshot_held_marks_missing:<symbol>`：完全沒有價格。
  - 處理方式：等當天精確收盤進 `stock_prices`（`market-close-refresh` 18:10、`daily-snapshot-settle` 18:25 會再跑一次）。**不可以**用舊價補，也不要手動寫 mark。
- **NAV 對帳（O04）**：現金與股數守恆，容差 1 NTD。差額超過容差會記 `nav_cash_flow_residual` warn，並在該 session 第一次寫 snapshot 時發 Discord；同一 session 重跑不會再發。

## 5. 唯讀查詢的避開時段（learning-db）

**Wei 10/29 決定：learning-db 唯讀查詢的避寫時段改為 13:30–16:30Z，17:00–23:00Z 不變。** 理由：chain 往後移 45 分鐘以後，晚間寫入大約落在 13:45–16:10Z（最晚的情況），原本的 13:00–15:40Z 蓋不住。這是營運規則，不是程式碼；其他文件提到舊時段的，以本 runbook 為準。

## 6. root 移到 21:45 的連動清單（C28-25 a）

「已改」都在 `wrel-eod-1320`，只有 runtime summary 字串在 `wrel-finlab-dispatch`。`infra/gcp-scheduler-jobs.json` 屬 SHARED deploy unit。行號是各 worktree 未 commit 的狀態。

| # | 項目 | file:line | 現值 | 處理 |
|---|---|---|---|---|
| 1 | evening-chain root | `infra/gcp-scheduler-jobs.json:59` | `0 13`（21:00） | **已改** `45 13`（21:45）＋description；SHARED，live sync 要 Wei go（§1） |
| 2 | root 顯示 | `worker/src/lib/schedulerStatus.ts:55`、`worker/src/routes/scheduleReadRoutes.ts:28` | 21:00 | **已改** 21:45 |
| 3 | contract tests | `worker/src/lib/eveningChainContract.test.ts:14-19`、`sourceReadinessProbeAutomationContract.test.ts:25-26`、`schedulerDependencyMapContract.test.ts:125`、`schedulerStatusDisplay.test.ts:94` | `0 13`／21:00 | **已改** `45 13`／21:45 |
| 4 | late lane cutoff | `data/finlab_source_contract.json:71`（finlab-dispatch、screener-alerts 各一份） | 23:00 | **不改（Wei 10/29 決定）**；重試從約 4 次變約 3 次（§2） |
| 5 | NEW-86 告警 23:30／23:50 | `screenerRecoveryWatchdog.ts:345,357-358`（screener-alerts） | cutoff＋30；最後 tick 23:50 | 不改：由 cutoff 與 manifest 推導，cutoff 不變就不變 |
| 6 | finlab-backfill-watchdog 排程 | `infra/gcp-scheduler-jobs.json:61` | `*/10 13-15`（21:00–23:50） | **不改（Wei 10/29 決定）**；21:00–21:50 的 tick 是空跑 |
| 7 | finlab-backfill-watchdog 顯示 | `schedulerStatus.ts:57`、`scheduleReadRoutes.ts:29` | 21:20-23:50 | **已改** 22:00-23:50（實際開始有作用的時間） |
| 8 | screener／indicator watchdog | `infra/gcp-scheduler-jobs.json:60,62` | `13-22` 起 21:00 | 不改：21:00–21:40 的 tick 無害；要從 21:40 起得拆成兩個 job |
| 9 | allocator watchdog | `infra/gcp-scheduler-jobs.json:63` | `*/10 13-17` | 不改：處理最新 lifecycle，和 root 無關 |
| 10 | external-evidence 23:15 | `infra/gcp-scheduler-jobs.json:66` | `15 15` | 不改：沒帶日期時取 `daily_recommendations` 中 signal／confidence 非空的最新日期（`tools/materialize_external_evidence_once.py:138-151`），這兩欄隔天早上才填，所以讀到的是前一個已發布日，和今晚 screener 何時完成無關 |
| 11 | screener 顯示 | `scheduleReadRoutes.ts:38` | `22:00 chain` | **已改** `after 21:45 chain` |
| 12 | runtime summary 字串 | `wrel-finlab-dispatch/worker/src/lib/updateOrchestrator.ts:2610-2676` | `21:00 root suppressed`、`21:00 evening-chain …` | **已改**成不帶時間的 `evening-chain root …`（同步更新 `eveningChainContract.test.ts:133,135`、`finLabLateLaneRetry.test.ts:264,293`）；沒有程式讀這些字串 |
| 13 | 註解 | `worker/src/lib/finlabSourceContract.ts:41` | "after the 21:00 capture" | **已改**為 "after the evening-chain root's first capture"（finlab-dispatch、screener-alerts 兩條 branch 改成一字不差，合併不衝突） |
| 14 | 測試 fixture | `schedulerPolicy.test.ts:44-48`、`schedulerStatusDisplay.test.ts:359-782` | 顯式 `0 13`／`21:00` | 不改：fixture 自帶 cron，不依賴 manifest |
| 15 | `dispatch_attempt` 上限 | `ml-controller/routers/finlab.py:59` | 5 | 不改（Wei 指定） |
| 16 | watchdog stale | `updateOrchestrator.ts:82` | 15 分 | 不改 |
| 17 | learning-db 避寫時段 | 營運規則（無程式） | 13:00–15:40Z、17:00–23:00Z | **改為 13:30–16:30Z（Wei 10/29 決定）**；17:00–23:00Z 不變（§5） |
| 18 | 隔天早上 | shadow-backfill `:69`（00:30）、active8 `:64`（01:55）、premarket 06:30 視窗、`premarket-evidence-watchdog` `:105`（07:00）、`morning-setup` `:104`（07:15） | 不變 | 不改：最晚 00:10 完成，餘裕足夠 |
| 19 | market-close-refresh／daily-snapshot-settle | `:58`（18:10）、`:55`（18:25） | 不變 | 不受影響（在 root 之前） |
| 20 | PIT K(t) | `r33/pit-cert:data/feature_registry/pit_availability_contract_v1.json:7` | 21:00 | **不改（Wei 10/29 決定）**（§2） |
| 21 | runtime scaling | `infra/gcp-runtime-scaling.json`（`40 13` Asia/Taipei） | 13:40 | 不受影響（下午 13:40，不是 root） |
| 22 | 其他 indicator watchdog 顯示 | `schedulerStatus.ts:58`（cron `*/5 13-17`、21:00-01:55）、`scheduleReadRoutes.ts:30`（21:00-01:55） | manifest 是 `13-22`／06:55 | 既有不一致，和本次無關，不改 |
| 23 | 舊 Worker cron 路徑的錯誤字串 | `worker/src/lib/cronWorkerDomainTasks.ts:43,47` | `TW 22:00 evening-chain` | 不改：`wrangler.toml` 的 `crons = []`，是不會執行的死路徑，舊排程下本來就寫錯 |

