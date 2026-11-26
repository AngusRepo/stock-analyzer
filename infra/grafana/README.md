# Grafana 儀表板（StockVision）

Stack：`narrowpeacock3250.grafana.net`，資料夾 `StockVision`。儀表板 JSON 由 `build/` 產生，不要在 Grafana 介面裡手改後存檔（下次產生會蓋掉）。

## 內容

| 路徑 | 說明 |
|---|---|
| `dashboards/sv-today.json` | ① 今天（現在要不要動手）：能不能出手、結論列（含最後回報時間）、要處理清單、必要階段狀態甜甜圈、未完成必要階段的餘裕、每日鏈（39 站）、近 24 小時起訖、資料就緒；收合：階段明細（含耗時） |
| `dashboards/sv-health.json` | ② 執行品質（過去 14 天哪裡常壞）：成功率與重複失敗、每業務日失敗站數（堆疊長條）、每日鏈結果比例（甜甜圈）、每日鏈每階段 14 天結果、四條鏈的近期失敗、每週／每月／盤中三條鏈、盤中鏈 14 天結果 |
| `dashboards/sv-model.json` | ③ 資源與模型：D1 容量（結論列、各庫圓形量表、容量表）、execution parity 與 RFS allocator、evidence clocks、Cloud Run／Scheduler（數字、每天成功／失敗、失敗集中在哪些 job、執行中、請求、延遲）；收合：監控讀取成本 |
| `dashboards/sv-mobile.json` | 手機：今天能不能出手、要處理、未完成必要階段、資料就緒（只列有問題的）、失敗中的階段；單欄 w=24 |
| `dashboards/gcp-cloud-run-scheduler.json` | Cloud Run／Scheduler 面板的來源（資源與模型頁從這裡取） |
| `dashboards/fixture/` | 同四頁，查詢改讀內嵌的測試夾具回應（未接線時看版面用）。產生物，不進 repo |
| `alerts/sv-chain-rules.json` | 六條告警規則（流程鏈 4、資料就緒、D1 容量），全部 `isPaused: true` |
| `build/` | 產生器 |

## 資料來源

| 資料源 | uid | 用在 |
|---|---|---|
| Infinity（監控 Worker） | `sv-monitoring` | 三頁所有 `/v1/...` 查詢、六條告警 |
| Infinity（stack 內建） | `grafanacloud-infinity` | 只有 fixture 版（內嵌資料，不對外連線） |
| Google Cloud Monitoring | `bg59sppgm7v9cb` | 資源與模型頁 Cloud Run／Scheduler |

監控 Worker 是 `worker/src/monitoring/`（唯讀）。每個端點回 `generated_at`、`rows_read`、`rows`；判斷（失敗、逾時、卡住、漏跑、預估餘裕、顯示狀態）都在 Worker 算，儀表板只畫圖和比門檻。

### `sv-monitoring` 資料源設定（等憑證建好才能做）
- 類型 Infinity，uid 固定 `sv-monitoring`。
- Base URL：監控 Worker 的 custom domain（`https://<monitoring domain>`）。查詢裡的 URL 都是 `/v1/...` 相對路徑。
- Allowed hosts：同一個 domain。
- Headers：`CF-Access-Client-Id`、`CF-Access-Client-Secret`（Access service token）與 `Authorization: Bearer <MONITORING_READ_TOKEN>`，都填在資料源的 secure 欄位，不進 repo。

要先由 Wei 建立的四件事：監控 Worker 的 custom domain、Cloudflare Access application、Access service token、Worker secrets（`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`MONITORING_READ_TOKEN`）。

## 產生與檢查

```bash
# 在有監控 Worker 的 checkout 的 worker/ 目錄下執行（用它的 tsx 與 miniflare）
node --import tsx ../infra/grafana/build/export-dag.mts ../infra/grafana/build/dag.json
node --import tsx ../infra/grafana/build/dump-fixtures.mts ../infra/grafana/build/fixtures
```

```bash
# 在 infra/grafana/build/ 下執行，不需要任何套件
node build.mjs --check          # live 與 fixture 兩份除了查詢來源以外必須逐欄相同
node build.mjs --mode live      # → dashboards/*.json
node build.mjs --mode fixture   # → dashboards/fixture/*.json
node alerts.mjs                 # → alerts/sv-chain-rules.json
```

- `dag.json`：流程鏈的 phase、主線、站名，來自監控 Worker 的 `judgment/`（和 OBS ExecutionChainPanel 同一份定義）；盤中、每週、每月三條鏈在 `other_chains`（`judgment/chainPhases.ts`）。站有增減時重跑 `export-dag.mts`，Canvas 位置與連線會跟著重排；三條鏈的面板寬度不夠放下所有站時 `build.mjs` 直接報錯。
- `fixtures/`：監控 Worker handler 在 Miniflare 測試夾具上的真實回應（產生物，不進 repo；`--mode live` 不需要它）。端點欄位有變動時重跑 `dump-fixtures.mts`，再跑 `--check`。

## 版面規則
- 版面位置照 mock 第三版（Grafana `sv-mock-v2` 資料夾）；只放有資料來源的面板，沒有來源的不放空殼（見最後一節）。
- 三頁各回答一個問題：① 今天＝現在要不要動手；② 執行品質＝過去 14 天哪裡常壞；③ 資源與模型＝容量、雲端 job、模型證據。
- 圖形依資訊型態選：比例用甜甜圈、每天的次數用直立堆疊長條、使用率用圓形量表、每站每天的結果用 status history、起訖用 state timeline；不用橫向 bar gauge。
- 每頁首屏是結論；明細與監控自身成本收進 collapsed row（row 一律放在頁尾，避免蓋住後面的面板）。
- 狀態色只有一套（`lib.mjs` 的 `STATUS`／`TONE`，Grafana 暖亮色）：綠 `#73bf69`＝完成、淺藍 `#8ab8ff`＝執行中、橘 `#ff9830`＝逾時或趕不上截止、紅 `#f2495c`＝失敗／卡住／漏跑、灰 `#5c606b`＝未開始；文字保留確切狀態。
- 價格報酬（之後的 Paper NAV）用台股慣例：正紅負綠，與狀態色分開；IC 這類非價格指標用單色加門檻線。
- rolling IC（等來源）：全部模型都畫，未過門檻的上色、其餘灰色；模型名冊加 sparkline 欄。
- 資料就緒的狀態欄只用四個字：正常／遲到／缺漏／未到（`READINESS_VOCAB`）。
- 空面板的文字：沒有資料來源＝「尚未接資料」；有來源但正常日是空的（要處理、失敗清單、只列異常的資料就緒）寫出它代表什麼，例如「沒有需要處理的事項」「全部到齊」。
- 時間範圍一律相對時間（live 版）；fixture 版是某一晚的快照，固定在那一晚。
- 起訖甘特用 `now-24h`，不用 `now/d`：每日鏈 17:30 起跑、跨午夜，`now/d` 過了 00:00 會切掉前一晚。
- Grafana 不支援單一 panel 的標題字級；數字字級維持 `titleSize 12／valueSize 20`。
- 手機版「今天能不能出手」：停＝每日鏈盤前段有必要階段失敗、漏跑或卡住；注意＝四條鏈有要處理的項目，或資料就緒有缺漏；其他＝正常。只讀監控資料。
- 桌面三頁頂端有「手機版」連結，手機版有「看完整版」連結（不列整個頁面清單）。

## 寫查詢要注意（Infinity backend parser，都實測過）
- selector 一律經 `querySource()` 包成 `([ … ])`。不是 `(` 或 `$` 開頭的 selector 不會被當成 JSONata，結果是一列 null，不會報錯。
- JSONata 結果是空的時候查詢會報 `no results found`；包成陣列後是空表。「要處理」在正常日就是空的。
- 回傳欄位照字母排；表格與 KPI 用 `organize` 排回宣告順序（`lib.mjs` 已處理）。
- state timeline／status history 用 `partitionByValues` 把長表拆成每站一列，列的順序是資料中第一次出現的順序，所以 selector 先照流程鏈順序排。

## 發佈
1. 建好 `sv-monitoring` 資料源後，Dashboards → Import，依序匯入 `dashboards/sv-*.json`（四頁）到資料夾 `StockVision`（uid 固定，重匯會覆蓋）。
2. 每頁確認沒有「尚未接資料」／查詢錯誤，再刪掉 `*-fixture` 四頁。
3. 告警：Alerting → Alert rules → Import，匯入 `alerts/sv-chain-rules.json`；確認每條查詢有值之後才逐條解除暫停，並接上 contact point。

## 還沒有來源的面板
資源與模型頁的 Paper NAV、rolling IC／名冊、訊號強度分段、OPB，執行品質頁的失敗分類、部署一致性、D1 讀寫量、帳單，今天頁的「等 go」清單，以及手機版的今日成本，來源調查在 `audits/grafana-obs-eval-20261124/p4_sources.md`（未進 repo），排定後補端點再加面板。

App 的 OBS 頁有、這裡還沒有的（監控 Worker 沒有對應端點，和上面一起排）：predeploy gate 結論、Threshold Policy（adaptive delta、Active-8 覆蓋）、LinUCB risk guard、GA promotion 指標與 gate、獨立排程 job 登錄（physical／unmapped／ticket 計數）、R2／GCS 容量、Pipeline 各 phase 耗時紀錄。GA promotion 的核准／退回按鈕留在 app（Grafana 只讀）。
