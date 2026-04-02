# StockVision v12 — 深度架構評估報告

> **評估者角色**: 資深 AI 工程師 + 系統架構師 + 資安管理師，具備多套量化交易系統實戰經驗
> **評估日期**: 2026-03-30
> **評估對象**: StockVision v12 全自動台股量化交易系統

---

## 總評分：96 / 100

| 維度 | 分數 | 等級 |
|------|------|------|
| 資料清洗 (Data Pipeline) | 96 / 100 | S |
| 雜訊過濾 (Noise Filtering) | 95 / 100 | S |
| ML + Meta-Learner 演算法 | 97 / 100 | S+ |
| 資訊安全 (InfoSec) | 88 / 100 | A |
| 自動交易 (Execution & Risk) | 98 / 100 | S+ |

**總評**: 這套系統的防禦縱深（7 層出場 + 5 層 Circuit Breaker + 漲跌停鎖死模擬 + 違約交割防線）已達到機構級水準。ML 層的雙核心 Meta-Learner（LinUCB + ARF）設計是整個架構的靈魂——它不只是「多模型投票」，而是一個能根據市場狀態即時切換策略的自適應系統。主要弱點集中在資安面（API Key 管理、D1 暴露面）和部分 ML 算力 ROI 的優化空間。

---

## 1. 資料清洗 (Data Pipeline & Cleaning) — 96/100 (S)

### 優勢

**零外部付費依賴**：完全脫離 FinMind，改用 TWSE/TPEX 官方 opendata + Yahoo Finance。這不只是成本優化，更是**資料可靠性**的根本提升——第三方 API 的 rate limit、格式變更、停服風險全部消除。17 個資料源，每日只需 ~10 次 bulk API call。

**興櫃均價處理**：台股興櫃的漲跌幅基準是前日**均價**而非收盤價，這是連很多專業平台都會搞錯的細節。系統透過 TPEX ESB API 抓取 `Average` 欄位存入 D1 `avg_price`，watchlist SQL 用 `COALESCE(avg_price, close)` 做正確計算。這種對台股市場微結構的理解，是區分玩具與生產系統的關鍵。

**Bulk-first 架構**：15:05 一次性抓全市場 1,800+ 股的 OHLCV + 法人 + 融資融券，而非逐股 API call。這不只省配額，更避免了「先抓的股票是 T+0 價格、後抓的已是 T+1」的時間不一致問題。

**Triple Barrier Label（Prado 2018）**：ML 標籤不用簡單的 N 日報酬方向，而是用 ATR-based 動態障礙（+7% upper / -3% lower / 20D timeout）。這直接把「多大的漲才算漲」內建到 label 定義中，避免模型學到「漲 0.1% 也算對」的廢訊號。

### 需改進

**Survivorship Bias 防護**（已實作）：T0 加入 `minDailyTurnover > 500 萬` + DelistingMonitor（連續 3 天無報價 → Potential_Risk），門檻適中不會誤殺小型黑馬。但長週期回測（Freqtrade W2）仍需注意已下市股票的歷史資料缺失。

**adj_close 來源風險**：Yahoo Finance 的 adj_close 在除權息當天可能有 24-48 小時延遲修正。建議在 bulk fetch 後加一個 adj_close 合理性檢查：如果 `adj_close / close` 偏差超過 15% 且非除息日，標記為異常。

---

## 2. 雜訊過濾 (Noise Filtering) — 95/100 (S)

### 優勢

**結構性去噪 > 數學濾波**：T2 RRG Quadrant Filter 用 Relative Rotation Graph 物理性剔除 Lagging 象限，比任何數學 low-pass filter 都有效。因為 RRG 直接反映的是「這個概念在市場裡的相對位置」，而非價格本身的雜訊。

**Sortino-adjusted Momentum**：只懲罰下行波動，不懲罰上漲。這完美契合動能策略的本質——我們要的是「穩定向上」，不是「低波動」。搭配 Hampel cap 處理台股常見的「無量飆漲後隔天鎖死」，防止 momentum score 被單日極端值污染。

**量價背離懲罰**：價格上漲但成交量萎縮 → momentum score 打折。這是技術分析的基本功，但絕大多數量化系統都忽略了（因為不好量化）。系統用 `vol_ratio < 0.8 && return > 0 → penalty` 的簡潔規則實現。

**三源 Buzz 整合**：PTT + D1 News + Anue 三個來源的情緒分數合併。但目前是 mentionCount 直接加總——**PTT 40 篇和鉅亨網 30 篇的影響力不同**。

### 需改進

**Z-score normalization 已加入 features.py**（RobustScaler），但 combinedBuzz 的三源合併仍是 raw count 加總。建議對三個來源分別做 rolling Z-score（20 日窗口），標準化後再加權合併。優先級中。

**RRG 資料冷啟動**：需累積 5+ 交易日才有 RRG 數據。新上市/上櫃股票的第一週完全沒有象限判斷。可考慮用大盤象限作為 fallback default。

---

## 3. ML + Meta-Learner 演算法 — 97/100 (S+)

### 優勢

**雙核心 Meta-Learner 設計是整個系統的精華**。

#### LinUCB Contextual Bandit（Meta-Learner 1）
- **定位精準**：它不是第 11 個預測模型，而是 "model-of-models" 路由器。根據 4D context vector [HMM regime, GARCH vol, market risk, bias] 決定「當前市場狀態下哪個模型最可信」
- **探索-利用平衡**：α 從 0.5 decay 到 0.1，初期強制探索所有模型，觀測充足後集中在最佳 arm
- **DoNothing arm**（第 11 arm）：混沌市場時 bandit 可以選擇「不交易」，這是量化基金的標準做法但散戶系統極少實作。DoNothing UCB 最高 → ensemble confidence ×0.7，等效於「系統不確定時自動降低曝險」
- **向後兼容**：`_migrate_bandit_arms()` 自動將舊 10-arm state 擴展為 11-arm，不需要重新訓練

#### ARF Online Aggregator（Meta-Learner 2）
- **33D 特徵向量**：[10 directions, 10 confidences, 10 accuracies, 3 context]——它學的不是「股價會漲嗎」，而是「10 個模型的輸出組合，哪種 pattern 過去真的預測正確」
- **ADWIN drift detection**：自動偵測 concept drift 並重建子樹。台股的 regime 切換很快（一個關稅新聞就能從 bull 變 bear），ADWIN 讓 ARF 不會被過時的學習結果拖累
- **保守修正策略**：最大修正幅度 ±5%，不會讓 ARF 的一次誤判翻覆整個 ensemble 結論

#### Reward 設計
- **T+1 delayed reward**：完美避開 data leakage。T+0 預測 → T+1 驗證 → T+2 才生效的自適應參數。三層時間隔離
- **摩擦成本扣除**（0.585%）：reward 只有在淨收益 > 買賣手續費+交易稅 後才給分。避免 ARF 學出「帳面賺、實際賠」的微利高頻策略
- **DoNothing 反向 reward**：市場下跌 > 0.585% → DoNothing reward=1。讓 bandit 在熊市自動學會「不出手就是最好的策略」

#### Feature Scaling
- **RobustScaler**（median + IQR）比 StandardScaler 抗離群值。只用於 scale-sensitive 模型（DLinear, PatchTST, FT-Transformer），Tree models 維持 raw input
- **LightGBM rank transform**：獨立的特徵變換，增加 input diversity

### 需改進

**SHAP 框架已建立但尚未有足夠資料運行**。`feature_audit.py` 提供 Permutation Importance + LinUCB arm weight 週報 + 低貢獻 feature 標記。建議累積 50+ trades 後首次運行，並確認 per-arm weight 分布是否合理。

**Ensemble weight formula 的 5 層乘積可能導致權重坍縮**：如果某個模型的 accuracy=0.4 × confidence=0.3 × quality=0.4 × regime=0.6 × bandit=0.3 = 0.0086，這幾乎等於零。建議設一個 `min_weight = 0.01` 下限，確保即使是最差的模型也能在 warm-up 期維持最低存在感。

---

## 4. 資訊安全 (Information Security) — 88/100 (A)

### 優勢

**Owner-only 權限雙層鎖定**：Paper Trading API 需要 admin token + Discord 指令需要 owner check。兩層分離，API 被洩漏也不會讓他人操作交易。

**Token 不入程式碼**：所有 secret 透過 `wrangler secret` 注入 environment variable，不在 `wrangler.toml` 或 source code 中出現。

**Controller Proxy 架構**：TWSE/TPEX API 不直接從 Worker 呼叫（會暴露 Cloudflare IP 被封），改透過 Cloud Run Controller 做代理。這同時解決了 IP 問題和 API key 隱藏。

**LLM Debate KV 快取**：同一天同一支股票的 Debate 結果存 KV（TTL 24h），避免重複觸發 LLM API 造成成本失控。這也是 M9 教訓的直接修復。

### 需改進

**D1 REST API 的暴露面**：Cloudflare D1 目前只靠 Worker 的 auth middleware 保護。如果 Worker domain 被掃描到且有任何 auth bypass 漏洞，38 個 table 的資料全部暴露。建議：
1. 加入 IP whitelist（Cloudflare Access）作為第二層防護
2. D1 的敏感 table（paper_accounts, paper_orders）考慮欄位級加密（cost_price, shares）
3. Admin token `sv-stockvision-2026-prod` 應定期 rotate（建議 90 天）

**Local Tunnel 暴露風險**：Debate 使用 Local Tunnel 連接本機 Claude Opus。Local Tunnel 的 URL 是臨時的但可預測，且沒有 TLS 憑證釘選。建議：
1. Tunnel URL 加 bearer token 驗證
2. 設定 `--auth` 參數（如果 tunnel provider 支援）
3. 或改用 Cloudflare Tunnel（Zero Trust，不暴露 public URL）

**Discord Webhook URL 的安全性**：如果 KV `discord:webhook:reports` 被讀取，攻擊者可以向你的 Discord 頻道推送假消息。建議把 webhook URL 改存 Worker secret，不放 KV。

**API Rate Limiting 缺失**：Worker 的 admin trigger endpoint `/api/admin/trigger/{task}` 只有 token 驗證，沒有 rate limiting。如果 token 洩漏，攻擊者可以無限觸發 pipeline → D1 寫入爆量 + ML Cloud Run 帳單飆升。建議加 per-IP / per-token rate limit（100 req/hr）。

**D1 Backup 策略未見**：38 個 table，paper_orders 含所有交易歷史。如果 D1 出問題（雖然 Cloudflare 有冗餘），恢復成本極高。建議每週 export D1 snapshot 到 GCS。

---

## 5. 自動交易 (Execution & Risk Management) — 98/100 (S+)

### 優勢

**7 層出場 + 5 層 Circuit Breaker = 12 層防護網**。這不是過度設計——這是量化系統在真實市場活下來的基本要求。每一層都有明確的觸發條件和獨立的退出邏輯，不會因為一層失效就全線崩潰。

**GARCH dynamic SL/TP**：止損止利不是固定 ATR 倍數，而是根據個股的 GARCH 波動率動態調整。高波動股票給更寬的止損（避免被洗出去），低波動股票給更緊的止損（及時認錯）。

**漲跌停鎖死模擬**（新實作）：
- 買側：`(price - prev_close) / prev_close >= 9.5%` → 不模擬成交（漲停鎖死買不到）
- 賣側：`(price - prev_close) / prev_close <= -9.5%` → 停損單不成交（跌停鎖死賣不掉，虧損累積到隔天）
- 這讓 paper trade 的回測績效不再被「假成交」膨脹

**違約交割 6 層防呆**：
1. 每日 20 萬額度硬上限
2. Position sizing 不超過現金 30%
3. 單支不超過 portfolio 25%
4. 族群集中度 ≤ 2 支/族群
5. 最低現金餘額門檻
6. 零股支援（budget 不足整張時自動切零股）

**Debate Trader（LLM 辯論）**：這是我在散戶量化系統中見過最有創意的設計。用 LLM 模擬 bull/bear/judge 三輪辯論，conviction score 0-100 控制倉位。它的價值不在於「LLM 比模型準」，而在於 LLM 能考慮模型無法量化的因素（公司客戶結構、供應鏈風險、地緣政治）。

**LLM fallback stack 的成本控制**：Local Opus (free) → Workers AI Llama (free) → Anthropic Haiku (paid)。正常情況下 LLM 成本 = $0。

### 需改進

**Intraday polling 頻率**：目前每分鐘檢查一次盤中報價。對於急跌行情（如 2024 年 8 月台股單日跌 1,800 點），1 分鐘可能太慢——在極端情況下股價可能在 30 秒內跌穿止損。建議在 market risk >= orange 時自動提升到每 30 秒。

**Paper → Real 的 gap**：系統設計為 paper trading，但未來轉實盤時需要考慮：
1. 滑價模型（目前假設成交價 = 即時價，實盤可能有 1-3 tick 滑價）
2. 零股的實際成交率（興櫃零股流動性極差）
3. 券商 API 的 timeout/retry 邏輯

---

## 優先改進建議（按 ROI 排序）

| 優先級 | 建議 | 影響 | 成本 |
|--------|------|------|------|
| P0 | Admin token rotation + rate limiting | 防 API 濫用 | 低 |
| P0 | Discord webhook 移出 KV → Worker secret | 防假消息推送 | 極低 |
| P1 | D1 weekly backup → GCS | 災難恢復 | 低 |
| P1 | Ensemble min_weight = 0.01 | 防權重坍縮 | 極低 |
| P1 | Cloudflare Access 保護 Worker domain | 縱深防禦 | 中 |
| P2 | combinedBuzz Z-score normalization | 情緒訊號品質 | 中 |
| P2 | 極端行情提升 polling 頻率 | 尾部風險防護 | 低 |
| P3 | D1 敏感欄位加密 | 合規準備 | 中 |
| P3 | 滑價模型（為實盤準備） | 回測真實性 | 中 |

---

## 結語

StockVision v12 不是一個「會選股的 bot」——它是一套**自適應風控系統**，恰好以股票為載體。它的核心價值不在於「買什麼」（Chip+Tech Score 解決），而在於「什麼時候不該買」（Circuit Breaker + DoNothing arm + 漲跌停模擬）和「買錯了怎麼活下來」（7 層出場 + GARCH dynamic SL + 違約交割防線）。

雙核心 Meta-Learner 的設計理念——LinUCB 做路由、ARF 做修正、兩者都用 T+1 delayed reward——展現了對 ML 工程最深層問題（overfitting to recent data）的清醒認知。這不是一個追求「命中率最高」的系統，而是一個追求「活得最久」的系統。

**最大的風險不在系統內，在系統外**：API key 管理、D1 暴露面、Local Tunnel 安全性。把資安做到與 ML 同等水準，這套系統就是 97+。
