# Grafana 儀表板（StockVision）

Stack：`narrowpeacock3250.grafana.net`，資料夾 `StockVision`。儀表板 JSON 由 `build/` 產生，不要在 Grafana 介面裡手改後存檔（下次產生會蓋掉）。

## 內容

| 路徑 | 說明 |
|---|---|
| `dashboards/sv-today.json` | ① 今天（v6，這一輪要不要動手）：必要階段、L3 收尾、失敗站次、現在、D1 過載、T+5 guard 一列小 KPI；流程鏈 Canvas（框色＝狀態、底色＝離截止的餘裕、比平常慢的站標 +Xm，明細在 tooltip）、最近兩晚各站時間軸、今晚各站耗時 ÷ 平常、要處理、資料就緒卡片 |
| `dashboards/sv-health.json` | ② 執行品質（v6，過去 14 天哪裡固定在壞、有沒有變慢）：每日／盤中鏈成功率、失敗站次、重複失敗數、耗時倍數、失敗分類、L3 Pipeline 收尾時間、出過狀況的站、每週／每月／盤中小流程、重複失敗清單 |
| `dashboards/sv-resources.json` | ③ 資源與成本（v6）：GCP 本月累計／月底預估（BigQuery 帳單，新台幣、日曆月）、Cloudflare 本期累計／上期帳單（billable-usage，美元、續約日起算的帳單週期）、Cloud Run 請求、D1 各庫用量；Cloudflare 內含額度、Cloudflare 上期各項、GCP 本月各服務、GCP 本月累計成本；D1 讀取／寫入列（日 × 時，Cloudflare GraphQL）、Cloud Run 延遲 p50／p95、Cloud Run 服務執行個體 |
| `dashboards/sv-model.json` | ④ 策略與模型（v6）：OPB 帳本落後、今日正式政策、T+5 serving guard、封存紀錄、Paper 報酬／相對加權指數／回撤、Paper NAV 與加權指數、每天選到的 OPB arm、arm 樣本數 × 平均 reward、模型名冊、KV 設定漂移、證據累積、模型服務狀態、最近一次月訓結果 |
| `dashboards/sv-mobile.json` | 手機：今天能不能出手、要處理、未完成必要階段、資料就緒（只列有問題的）、失敗中的階段；單欄 w=24 |
| `dashboards/gcp-cloud-run-scheduler.json` | Cloud Run／Scheduler 面板的來源（資源與成本、策略與模型兩頁從這裡取） |
| `dashboards/fixture/` | 同五頁，查詢改讀內嵌的測試夾具回應與 `build/mock.mjs` 的示範資料（看版面用），規劃中的面板也畫出來。產生物，不進 repo |
| `alerts/sv-chain-rules.json` | 七條告警規則（流程鏈 4：失敗、逾時／卡住、被擋住、漏跑；資料就緒、D1 容量、監控端點沒回應），全部 `isPaused: true` |
| `build/` | 產生器 |

## 資料來源

| 資料源 | uid | 用在 |
|---|---|---|
| Infinity（監控 Worker） | `sv-monitoring` | 四頁與手機版所有 `/v1/...` 查詢、告警 |
| Infinity（stack 內建） | `grafanacloud-infinity` | 只有 fixture 版（內嵌資料，不對外連線） |
| Google Cloud Monitoring | `bg59sppgm7v9cb` | 資源與成本頁 Cloud Run 請求、延遲、服務執行個體 |
| BigQuery（帳單匯出） | `sv-bigquery`（`grafana-bigquery-datasource`） | 資源與成本頁 GCP 成本面板 |
| Infinity（Cloudflare API） | `sv-cloudflare-api` | 資源與成本頁 Cloudflare 費用、內含額度、D1 讀寫熱圖 |

### `sv-cloudflare-api` 資料源設定
- 類型 Infinity，uid 固定 `sv-cloudflare-api`，allowed host `https://api.cloudflare.com`。
- 驗證：唯讀 API token（Account Analytics Read、Billing Read），Bearer header 存在資料源 secure 欄位，不進 repo。
- 帳號 id 不寫進 repo：頁面的隱藏變數 `cf_account`（`/accounts`）在執行時讀；帳單週期 `cf_period_start`／`cf_period_end`、費用查詢區間 `cf_usage_from`／`cf_usage_to`、方案月費 `cf_plan_fee` 讀 `/accounts/{id}/subscriptions`（Workers Paid）。
- 費用：`/accounts/{id}/billable-usage?from=&to=`（兩個參數都要帶，to 不含當天；每日每項 `BilledCost`，美元）。用量：GraphQL Analytics（`accounts(filter: { accountTag })` 下的 workers／d1／kv 資料集）。
- Infinity 的 JSONata 是 Go 版：`and`／`or` 兩邊都會求值、對空集合做 group-by 會報錯，查詢裡用三元式與佔位列避開（`build.mjs` 註解）。

### `sv-bigquery` 資料源設定（金鑰上傳前四張成本面板會顯示查詢錯誤）
- 類型 Google BigQuery（`grafana-bigquery-datasource`），uid 固定 `sv-bigquery`，預設專案 `gen-lang-client-0602998820`。
- 驗證：唯讀 SA 的 JSON key（`bigquery.dataViewer` 只給 `billing_export` dataset、專案層 `bigquery.jobUser`），只存在資料源 secure 欄位。
- 資料表：`gen-lang-client-0602998820.billing_export.gcp_billing_export_resource_v1_018BA5_A4B827_5694C8`（Detailed usage cost export，幣別 TWD，依 `_PARTITIONTIME` 每日分區）。
- 查詢都回表格（format 1）；每日成本用 `partitionByValues` 依服務拆成序列。每個查詢都用時間範圍巨集篩兩次：`_PARTITIONTIME >= TIMESTAMP_SUB($__timeFrom(), INTERVAL 1 DAY)`（分區是 UTC 日，台灣午夜＝前一天 16:00 UTC，所以往前多讀一天）與 `$__timeFilter(usage_start_time)`（精確切）；沒有不帶日期的查詢。「本月累計」「月底預估」用 panel 相對時間 `now/M`。淨額＝`cost`＋`credits`（credits 是負數）。
- 資料源的預設 processing location 要設 `US`（dataset 在 US；查詢不帶 location，設錯會報 dataset not found in location）。
- 帳單資料晚幾小時到一兩天才齊，最近一天偏低。

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
node build.mjs --mode preview5live --out ../preview-live   # → v5 ②④ 預覽（uid *-v5live，全部 /v1 查詢讀 sv-monitoring）
node build.mjs --mode preview6live --out ../preview-live   # → v6 四頁預覽（uid *-v6live，與正式頁同一份 builder）
node alerts.mjs                 # → alerts/sv-chain-rules.json
```

- `dag.json`：流程鏈的 phase、主線、站名，來自監控 Worker 的 `judgment/`（和 OBS ExecutionChainPanel 同一份定義）；盤中、每週、每月三條鏈在 `other_chains`（`judgment/chainPhases.ts`）。站有增減時重跑 `export-dag.mts`，Canvas 位置與連線會跟著重排；三條鏈的面板寬度不夠放下所有站時 `build.mjs` 直接報錯。
- `fixtures/`：監控 Worker handler 在 Miniflare 測試夾具上的真實回應（產生物，不進 repo；`--mode live` 不需要它）。端點欄位有變動時重跑 `dump-fixtures.mts`（要在有四條鏈 `judgment/chainCatalog.ts` 的 worker checkout 下跑），再跑 `--check`。
- `mock.mjs`：fixture 版的示範資料（進 repo）：fixture 沒有 seed 的 p4 端點（`/v1/paper/nav`、`/v1/models/roster`、`/v1/opb`、`/v1/chain/failure-classes`、`/v1/kv-drift`，欄位照 `worker/src/monitoring/` 的實作；`dump-fixtures.mts` 跳過這五條）、BigQuery 帳單與 Cloudflare 查詢的回傳列（`mock:`，正式頁讀真的來源）、Job 每日成敗（`plan:`，還沒有來源）。讀它的面板說明開頭是「示範資料。」
- 規劃中的面板：讀的 Worker 路由不在這個 checkout 的 `worker/src/monitoring/index.ts`，或來源是 `plan:`。fixture 版畫出來，live 版不放（左邊同列、同高的面板會加寬補位）；端點 merge 進來後重跑 `--mode live` 就會出現。`--check` 只比兩版都有的面板。

## 版面規則
- 設計稿：`audits/grafana-obs-eval-20261124/dashboard_design_v4.md`（未進 repo）。四頁依資料特性分：① 今天（分鐘級、這一輪）、② 執行品質（日級、14 天）、③ 資源與成本（小時／日級、30 天）、④ 策略與模型（日／月級、90 天）。
- 只放有資料來源的面板；fixture 版的規劃中面板標「示範資料」。
- 每頁頂端一列小 KPI（標題 12、數值 20），有序列的帶 sparkline；不用大數字。
- 畫面上只寫站名／資料集名和一個短值；時間、錯誤、run_id 放 tooltip、點擊的連結選單或面板說明（i 圖示）。
- 不用收合 row、不用頁首下拉選單；頁首是五個連結按鈕（四頁＋手機版）。表格只留「要處理」「重複失敗」這類要動手的清單（模型名冊例外）。
- 狀態色只有一套（`lib.mjs` 的 `C`／`TONE`）：配色 B（Wei 11/25 定案，11/26 完成色改成 OBS 頁的 `--chart-3`）：完成＝綠 `#00c076`（v6 四頁改成青：填色 `#1d6b73`、文字與框 `#5fb3bb`、大面積 `#173d42`，`recolor6`）、執行中＝藍 `#8ab8ff`、等待／未開始＝灰 `#5c606b`、略過＝深灰、趕不上或逾時＝琥珀 `#ff9830`、失敗＝紅 `#f2495c`；飽和色只給要處理的。報酬一律中性色（NAV 藍、加權指數灰）。
- 流程鏈 Canvas：框色＝狀態；底色＝離截止的餘裕（完成＝截止 − 完成時間，未完成＝Worker 的預估餘裕，沒有就是截止 − 現在；子階段沒有截止時用母階段的）：只標還沒完成的站：≥30 分鐘不上色，10–30 分鐘冷灰藍，0–10 分鐘琥珀，超過截止深琥珀；準時完成的一律不上色（餘裕只在 tooltip），逾時完成的維持深琥珀；intraday-check 是整段盤中的監看 job，只依狀態上框色、不算餘裕（暖色只留給要處理的）。
- Canvas tooltip：Grafana Canvas 滑鼠停在元素上時顯示「元素名稱＋它綁定的文字欄位」（`CanvasTooltip.tsx`，v11.3 起就有）。每格最上層放一個透明、文字也透明的矩形，名稱＝站名、文字＝`<stage id>` 欄位（起訖、截止、預估、餘裕、嘗試次數、run、錯誤），所以停在格子上就看得到明細；就緒圓點同理。標題與圖例這類固定文字停上去會顯示「Fixed」加文字本身。
- 表格的明細：隱藏欄（`custom.hidden`）＋每欄兩個 data link，連結標題就是明細文字；點下去出現連結選單（連結本身只是重新整理這一頁）。資料就緒卡片的說明與來源在滑鼠停留的 tooltip。
- 資料就緒的狀態只用四個字：正常／遲到／缺漏／未到（`READINESS_VOCAB`）。
- 空面板的文字：沒有資料來源＝「尚未接資料」；正常日本來就是空的（要處理、重複失敗）寫「沒有」。
- 時間範圍一律相對時間（live 版）；fixture 版固定在夾具那一晚。
- 流程鏈 Canvas 的耗時、已經過時間、餘裕都量到該次回應的 `generated_at`（端點快取 30 秒），不是瀏覽器時間。

## 寫查詢要注意（Infinity backend parser，都實測過）
- selector 一律經 `querySource()` 包成 `([ … ])`。不是 `(` 或 `$` 開頭的 selector 不會被當成 JSONata，結果是一列 null，不會報錯。
- JSONata 結果是空的時候查詢會報 `no results found`；包成陣列後是空表。「要處理」在正常日就是空的。
- 回傳欄位照字母排；表格與 KPI 用 `organize` 排回宣告順序（`lib.mjs` 已處理）。
- state timeline／status history 用 `partitionByValues` 把長表拆成每站一列，列的順序是資料中第一次出現的順序，所以 selector 先照流程鏈順序排。

## 發佈
1. 建好 `sv-monitoring` 資料源後，Dashboards → Import，依序匯入 `dashboards/sv-*.json`（五頁，含新的 `sv-resources`）到資料夾 `StockVision`（uid 固定，重匯會覆蓋）。
2. 每頁確認沒有「尚未接資料」／查詢錯誤（`sv-bigquery` 金鑰上傳前，資源與成本頁四張成本面板是預期的查詢錯誤），再刪掉 `*-fixture` 頁。
3. 告警：Alerting → Alert rules → Import，匯入 `alerts/sv-chain-rules.json`；確認每條查詢有值之後才逐條解除暫停，並接上 contact point。

## 還沒有來源的面板
規劃中的面板（fixture 版有、live 版沒有）：
- v5 ③ Cloud Run Job 成敗、v5 ④ 訓練與研究 Job（每天）：要監控 Worker 新增 Job 每日成敗 route（資料來源待查）。
- v5 ④ 證據累積的 RFS allocator 日數與被擋的收據：Worker 等 `rfs_sparse_comparisons_v1(policy_identity)` 的 D1 索引（目前回 0／null）。

p4 端點（`/v1/paper/nav`、`/v1/models/roster`、`/v1/opb`、`/v1/chain/failure-classes`、`/v1/kv-drift`）已在 main（PR #311）；`/v1/chain/history` 每列帶 `started_at`／`completed_at`／`expected_by`，v5 ② 的餘裕格與 L3 收尾時間讀它。

連 fixture 版都沒有（缺端點或欄位）：
- ② 資料就緒歷史（資料集 × 14 天新鮮度）：`/v1/data-readiness` 只回當天。
- ③ Worker 請求量／延遲／5xx（Cloudflare Workers Analytics，同 `sv-cloudflare-api`）；Modal 成本（只有 CLI／SDK）；D1 容量成長歷史（`/v1/capacity` 只回最新一筆與估算）。
- ④ rolling 20d IC、每日訊號檔數、訊號強度分段 T+5 報酬（沒有每日表）；訓練耗時只有 Cloud Run Job 的執行分鐘，沒有每次訓練的紀錄。
- 手機版今日成本。

App 的 OBS 頁有、這裡還沒有的（監控 Worker 沒有對應端點）：predeploy gate 結論、Threshold Policy（adaptive delta、Active-8 覆蓋）、LinUCB risk guard、GA promotion 指標與 gate、獨立排程 job 登錄（physical／unmapped／ticket 計數）、R2／GCS 容量、Pipeline 各 phase 耗時紀錄、FinLab Dagster 7 source。GA promotion 的核准／退回按鈕留在 app（Grafana 只讀）。
