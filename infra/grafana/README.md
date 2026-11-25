# Grafana 儀表板（StockVision）

Stack：`narrowpeacock3250.grafana.net`，資料夾 `StockVision`。儀表板 JSON 由 `build/` 產生，不要在 Grafana 介面裡手改後存檔（下次產生會蓋掉）。

## 內容

| 路徑 | 說明 |
|---|---|
| `dashboards/sv-today.json` | 今天：每日鏈（39 站）、盤中守門（8 站）、四條鏈的要處理清單、近 24 小時起訖、預估餘裕、資料就緒 |
| `dashboards/sv-health.json` | 健康：每週鏈（13 站）、每月鏈（4 站）、每日鏈每階段 14 天結果、四條鏈的重複失敗、D1 容量、監控讀取成本、Cloud Run／Scheduler |
| `dashboards/sv-model.json` | 模型：evidence clocks、execution parity |
| `dashboards/gcp-cloud-run-scheduler.json` | Cloud Run／Scheduler 面板的來源（健康頁從這裡取） |
| `dashboards/fixture/` | 同三頁，查詢改讀內嵌的測試夾具回應（未接線時看版面用）。產生物，不進 repo |
| `alerts/sv-chain-rules.json` | 六條告警規則（流程鏈 4、資料就緒、D1 容量），全部 `isPaused: true` |
| `build/` | 產生器 |

## 資料來源

| 資料源 | uid | 用在 |
|---|---|---|
| Infinity（監控 Worker） | `sv-monitoring` | 三頁所有 `/v1/...` 查詢、六條告警 |
| Infinity（stack 內建） | `grafanacloud-infinity` | 只有 fixture 版（內嵌資料，不對外連線） |
| Google Cloud Monitoring | `bg59sppgm7v9cb` | 健康頁 Cloud Run／Scheduler |

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

## 寫查詢要注意（Infinity backend parser，都實測過）
- selector 一律經 `querySource()` 包成 `([ … ])`。不是 `(` 或 `$` 開頭的 selector 不會被當成 JSONata，結果是一列 null，不會報錯。
- JSONata 結果是空的時候查詢會報 `no results found`；包成陣列後是空表。「要處理」在正常日就是空的。
- 回傳欄位照字母排；表格與 KPI 用 `organize` 排回宣告順序（`lib.mjs` 已處理）。
- state timeline／status history 用 `partitionByValues` 把長表拆成每站一列，列的順序是資料中第一次出現的順序，所以 selector 先照流程鏈順序排。

## 發佈
1. 建好 `sv-monitoring` 資料源後，Dashboards → Import，依序匯入 `dashboards/sv-*.json` 到資料夾 `StockVision`（uid 固定，重匯會覆蓋）。
2. 每頁確認沒有 No data／查詢錯誤，再刪掉 `*-fixture` 三頁。
3. 告警：Alerting → Alert rules → Import，匯入 `alerts/sv-chain-rules.json`；確認每條查詢有值之後才逐條解除暫停，並接上 contact point。

## 還沒有來源的面板
模型頁的 Paper NAV、rolling IC／名冊、訊號強度分段、OPB，健康頁的失敗分類、部署一致性、D1 讀寫量、帳單，以及今天頁的「等 go」清單，來源調查在 `audits/grafana-obs-eval-20261124/p4_sources.md`（未進 repo），排定後補端點再加面板。
