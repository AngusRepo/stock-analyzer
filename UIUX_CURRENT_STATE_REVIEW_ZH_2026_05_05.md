# StockVision UI/UX 現況比對與優化調整報告

日期：2026-05-05
範圍：現行前端 UI、Research Workbench demo、Refactor Pack 2026-V1
狀態：中文比對版，供下一輪 UI/UX 實作決策使用

## 一、結論

StockVision 目前已經不是完全「入門感」介面，因為 `AppShell`、`WorkstationChrome`、`ObservabilityPage` 已經有工業級交易工作站的雛形。但整體體驗還不一致：全域殼層像 workstation，Dashboard 本體仍像舊式 stock dashboard，研究層尚未正式產品化，管理/觀測頁也還有標籤、文案與資訊層級不乾淨的問題。

剛上板的 `/demo/research-workbench` 比現行 UI 更接近目標方向，原因不是它比較「炫」，而是它把題材、每日焦點、個股研究、AI 代理決策、基礎設施觀測放進同一個研究工作台，資訊架構比較清楚。

我建議下一步不是直接把 demo 套到首頁，而是把現行 UI 分層重整：`Research / Decision / Execution / Operations / Lab`。Research Workbench 應該先成為新的研究層，不要塞回現在已經過重的 `Dashboard.tsx`。

## 二、現行 UI 確認

### 已經做對的地方

`AppShell` 已具備專業工作台雛形：

- 固定左側導航。
- 頂部市場 ticker。
- admin-aware nav。
- route prefetch。
- compact top bar。
- 深色終端風格。

`WorkstationChrome` 已經提供可復用的 workstation primitives：

- `WorkstationPanel`
- `WorkstationPill`
- `WorkstationPageTitle`
- tone vocabulary：`ok / warn / error / info / neutral`

`ObservabilityPage` 的方向正確：

- incident
- scheduler
- data quality
- model health
- resource

這些模組已經接近 Grafana-style operations center，只是文字與資訊呈現還不夠乾淨。

### 目前主要問題

1. `Dashboard.tsx` 責任過重  
目前 Dashboard 同時處理 watchlist、stock hero、技術圖、籌碼、融資、財務、AI report、新聞、market risk、recommendation、admin users。這讓它很難再承接新的研究層，也讓 UI 結構難以穩定演進。

2. 導航和實際 route 不完全一致  
`App.tsx` 有 `/pipeline`、`/scheduler`、`/data-quality`、`/demo/research-workbench`，但 `AppShell` 的主 nav 目前沒有完整呈現這些 route。使用者會看到功能存在，但入口不完整。

3. Workstation 風格還沒有統一 token  
現行 UI 有 amber、sky、rose、emerald、grid、gradient、glow 等元素，但 token 還沒有完整收斂到 Refactor Pack 的 Industrial Dark 規格。

4. 可見文案仍有污染風險  
`AppShell` 仍有 `Google ?餃` 這類破碎文字。Dashboard、Observability、workstation decision components 也仍可見 mojibake 或破碎文案。這會直接降低產品可信度。

5. Research 層尚未正式成立  
現行系統強在 ML、Recommendation、Scheduler、Bot、OBS，但使用者要理解「今天市場在炒什麼、題材怎麼傳導、個股為什麼被選中」時，沒有一個正式入口。

## 三、上板 demo 比對

### Demo 已改善的地方

`/demo/research-workbench` 建立了新的研究層骨架：

- 題材工作台。
- 每日焦點。
- 個股研究。
- source coverage。
- Local LLM telemetry。
- R&D lab topology。

這版比現行 Dashboard 更像「研究產品」，因為它不是把更多卡片堆在首頁，而是把使用者研究流程重新組織。

### Demo 目前的限制

1. 還是靜態資料  
目前 demo 不接 production API，這是刻意設計，適合先驗證 UI/UX，不適合直接當正式頁。

2. 不該直接成為首頁  
它應該先成為 `/research` 或 hidden research route，等資料契約完成後再進主導航。

3. 右側 telemetry 是方向展示  
Local LLM memory、TPS、CF/D1 write freshness、R&D topology 現在是概念展示，後續需要真實資料來源與 stale-state 設計。

4. ETF 已移除  
依照你的最新決策，demo 已刪除 ETF 模組。之後若要補 ETF，應該重新作為獨立資料層評估，不要混回這版 Research Workbench。

## 四、與 Refactor Pack 2026-V1 對照

### 已符合

- 專業量化平台定位。
- 工業級暗色方向。
- 高密度資訊呈現。
- AI 代理決策與基礎設施觀測被納入 UI 語彙。
- Demo 沒有引入新依賴，避免未審查的 dependency drift。

### 尚未符合

- 尚未使用真正的多視窗系統。
- 尚未導入 Jotai/Zustand 的高頻狀態分離。
- 尚未有真正的 Local LLM telemetry。
- 尚未有 Cloudflare / D1 / Modal / GCS 的動態資料流動畫面。
- K 線 confidence bands 還沒有接入現有 chart。

### 工程判斷

`Jotai`、`Zustand`、`flexlayout-react` 的方向是合理的，但不應該在 demo 階段直接加入。現有 `frontend/package.json` 沒有這些依賴，下一步應先完成 read-only data contract 與 navigation 分層，再評估是否真的需要 dockable window system。

## 五、建議目標資訊架構

### Research

用途：市場研究與題材理解。

建議 route：

- `/research`
- `/research/topic/:topicId`
- `/research/stock/:symbol`

模組：

- 題材工作台。
- 每日焦點。
- 個股研究。
- source coverage。
- MOPS/event stream。
- 新聞與題材映射。

### Decision

用途：ML 與推薦決策溯源。

建議 route：

- `/bot`
- `/strategy-lab`

模組：

- ensemble_v2 signal。
- confidence / signal provenance。
- AI debate / policy layer。
- pending buy readiness。

### Execution

用途：paper trading 與真實交易前檢查。

建議 route：

- `/execution`
- `/paper`

模組：

- pending orders。
- quote sanity。
- slippage / liquidity。
- stop / target readiness。

### Operations

用途：系統觀測與事故處理。

建議 route：

- `/obs`
- `/pipeline`
- `/scheduler`
- `/data-quality`
- `/model-pool`

模組：

- incident center。
- pipeline execution。
- data freshness。
- model artifacts。
- retrain status。
- Cloudflare / D1 / Modal / GCS health。

### Lab

用途：實驗與多代理分析。

建議 route：

- `/lab`

模組：

- R&D Lab Mode。
- AI Debate Arena。
- agent topology。
- local LLM telemetry。
- adaptive threshold experiments。

## 六、優先級調整建議

### P0：清乾淨現行可見 UI

- 修掉 `AppShell` 登入文字污染。
- 清 `Dashboard.tsx` 的可見 mojibake。
- 清 `ObservabilityPage` tab labels 與狀態文案。
- 清 `DecisionArchitecture.tsx` 內破碎中文。
- 移除或替換 `API logic unchanged`、`Workstation skin active` 這種內部實作提示。

### P1：統一全域導航

把 `AppShell` 改成分組 navigation registry：

- Research：Dashboard、Research Workbench、Stock Report。
- Decision：Bot、Strategy Lab。
- Operations：OBS、Pipeline、Scheduler、Data Quality、Model Pool。
- Lab：R&D Lab。

這會解決目前 route 存在但 nav 不完整的問題。

### P1：把 Dashboard 拆開

建議拆成：

- `MarketOverview`
- `WatchlistRail`
- `StockWorkspace`
- `DecisionSummary`
- `ResearchDigest`

Dashboard 不應再繼續吸收題材、每日焦點、R&D Lab 這些新模組。

### P1：建立 Research read-only contract

先定義資料形狀，不急著接 live data：

- `topicRegistry`
- `dailyFocus`
- `stockResearchSummary`
- `sourceCoverage`
- `eventStream`
- `agentTopologyPreview`

這個 contract 應該只讀取現有資料，不改 prediction、retrain、paper trading。

### P2：把 OBS 做成 Operations 首頁

OBS 應該成為 Operations layer 的首頁，而不是單純一個 admin 頁。Pipeline、Scheduler、Data Quality、Model Pool 變成 drilldown 頁。

### P2：再評估 terminal dependencies

等 `/research` 真正有資料後，再評估：

- `Jotai` vs `Zustand`
- `flexlayout-react`
- 真正多視窗布局
- 高頻 ticker state isolation

## 七、下一輪實作建議

我建議下一輪先做這一包，不碰 deploy：

1. 清 `AppShell` visible copy。
2. 建立 grouped nav registry。
3. 把 `/demo/research-workbench` 暫時加到 Research 分組，但標成 demo。
4. 清 `ObservabilityPage` 可見標籤污染。
5. 寫 `research` read-only contract 草案。

這一包完成後，使用者會先感覺「產品變乾淨、入口變合理」。再往後才是 Dashboard 拆分與真資料接入。

## 八、目前不建議做的事

- 不建議直接把 demo 取代首頁。
- 不建議現在加入 `flexlayout-react`。
- 不建議現在加入 `Jotai/Zustand`。
- 不建議把 Research Workbench 接進 retrain 或 prediction path。
- 不建議把 ETF 偷偷加回這版 demo。
- 不建議在文案未清乾淨前 deploy 前端。

## 九、判斷

StockVision 現在的方向是對的，但需要從「功能堆疊」轉成「工作流分層」。  

現行 workstation shell 是好基礎，Research Workbench demo 是好方向。真正要做的是把兩者用乾淨的資訊架構接起來，讓研究、決策、執行、觀測、實驗各自有清楚的位置。

## 十、2026-05-05 收尾狀態

本輪 UI/UX 已從原本偏工業終端的方向，調整成更適合個人使用的生活化量化工作台。核心原則是保留資訊密度與監控能力，但降低冷硬感，讓入口更像「每天早上會打開的研究桌面」。

已完成：

- `AppShell` 已改成生活化分組導航：每日、行動、照護。
- `/` 已定位為「晨間概覽」，不再以 Dashboard 當主要心智模型。
- `/research` 已正式掛上研究室入口，`/demo/research-workbench` 仍保留相容。
- `/bot` 已改為「模擬交易室」，文案從 Bot Dashboard 轉成個人交易伴侶。
- `/obs`、`/pipeline`、`/scheduler`、`/data-quality`、`/model-pool` 已整理為照護/系統健康語彙。
- `StrategyLabPage` 已改成「策略實驗室」，避免 Strategy Lab demo 感。
- 已移除未接線的 `TradingDecisionBoards.tsx` 舊展示元件，避免之後誤用舊終端風格。
- commit 前瀏覽器 smoke QA 發現 lazy routes 在本機瀏覽器會停在 Suspense loading；已將核心頁面改成靜態 import，確保主入口可穩定開啟。
- 全 `frontend/src` 已掃描：舊 UI 詞與疑似 UTF-8 編碼污染皆為 0。

仍建議後續做，但不阻擋這次 commit/deploy：

- 用瀏覽器逐頁看桌機與手機版面，特別是 `/research`、`/bot`、`/obs`、`/model-pool`。
- 把 `/research` 從靜態 demo data 接成 read-only contract，不碰 retrain、prediction、paper trading。
- 決定是否保留少量英文 kicker，例如 `System care`、`Research room`、`Paper trading companion`；目前保留是為了視覺節奏，不是功能依賴。
- 再拆 `Dashboard.tsx`，把 watchlist、stock workspace、market overview、research digest 拆成更小模組。

Commit / deploy 前建議檢查：

- `frontend` 跑 `npm run build`。
- 瀏覽器 smoke QA 主入口：`/`、`/research`、`/bot`、`/obs`、`/pipeline`、`/scheduler`、`/data-quality`、`/model-pool`、`/strategy-lab`。
- 掃描 `frontend/src` 的舊 UI 詞與編碼污染。
- 若這次 commit 會包含 worker / ml-controller 既有改動，需額外跑對應測試；不要只用前端 build 覆蓋整包風險。
