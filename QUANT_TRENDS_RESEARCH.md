# GitHub 量化交易新趨勢研究 — 對 stock-analyzer 的吸收建議

**研究日期**：2026-04-16
**研究範圍**：GitHub 2025-2026 量化交易、LLM trading agent、time-series foundation models、agentic workflow
**對應系統**：stock-analyzer（Taiwan stock，Worker + ml-controller + Modal 三層架構，11-model ensemble）

---

## TL;DR

掃完 10+ 個 GitHub 搜尋查詢，2025-2026 年量化交易主要有 **4 大新趨勢**。對 stock-analyzer 來說最有 ROI 的兩件事：

1. **🥇 QuantaAlpha 式 LLM factor mining** — 用 LLM 自動挖新 alpha factors，paper 在 CSI 300 達 IC 0.15 / ARR 27.75% / MaxDD 7.98%
2. **🥈 FinMem 分層記憶接進 debate** — 補我們 debate 缺乏歷史 thesis 連續性的問題

兩者都可獨立 sprint 完成。其餘 GitHub 熱門項目（NautilusTrader、FinRL、TradingAgents 已分析過）對我們**邊際收益不夠大**或**已有等價實作**。

---

## 四大趨勢（2025-2026 GitHub 量化觀察）

| 趨勢 | 代表項目 | 對我們意義 |
|------|---------|----------|
| **LLM 變成 factor 挖掘者** | QuantaAlpha (清華 2025/04)、AlphaAgent (SUSTech 2025) | 🟢 **Feature engineering 自動化**是我們最大缺口 |
| **Trading-specific fine-tuned LLM** | Trading-R1（TauricResearch 2025/09）| 🟢 Debate Fulcrum 層可升級（但訓練資料是美股）|
| **Time-series FM multivariate 化** | Chronos-2、Moirai-2、TimesFM 2.5（2024-2025 三家大廠）| 🟡 我們 Chronos v1 可升級，但 ROI 邊際 |
| **Agent memory 分層** | FinMem (ICAIF 2024)、TradingAgents 多輪辯論 | 🟢 Debate 層加歷史 thesis，解決 narrative drift |

---

## 詳細項目評估

### 🟢🟢 第一名：QuantaAlpha — LLM-Driven Alpha Mining

**Repo**：https://github.com/QuantaAlpha/QuantaAlpha
**Paper**：[arXiv 2602.07085](https://arxiv.org/abs/2602.07085)
**團隊**：清華 + 北大 + CAS + CMU + HKUST 等聯合（2025/04 發布）

**核心架構**：
- LLM 提出假設 → 自動生成 factor 表達式 + 可執行 code → 回測 → 評估
- **trajectory-level mutation & crossover**：每次 mining 是一條 trajectory，對 trajectory 做進化操作
- 強制 hypothesis / factor expression / code 三者**語意一致**
- Constraint factor **複雜度** + **擁擠度** 避免 overfitting / alpha decay

**驗證結果**（GPT-5.2）：
- CSI 300：**IC 0.1501、ARR 27.75%、MaxDD 7.98%**
- Cross-market transfer：CSI 500 **+160% / 4 年累積超額**、S&P 500 **+137%**

**對我們的差距分析**：
- 目前 106 個 features 全靠**人工設計**
- Feature pool 擴增靠人力研究（每月 Modal monthly retrain 含 feature selection，但 selection 是 from existing pool，不是 discover new）
- **沒有自動化 factor discovery loop**

**建議導入方式**：
- 新模組 `ml-controller/services/alpha_mining_service.py`
- LLM 每月跑一次 factor proposal（用 Modal GPU）
- 收斂後通過 walk-forward WFE gate（我們已有！）的 factors 加入 `feature_pool.json`
- 整合到既有 monthly retrain cron，不破壞現有流程

**為什麼是第一名**：
- 直接擴增 feature pool（不只是改良既有 model，是質的突破）
- 我們有 Modal GPU + TEJ/FinMind 資料 + LangGraph → 三件事 match
- 頂刊級 paper 背書 + open source 可直接 fork
- 自然搭配我們新 commit 的 **Per-Fold WFE Gate**（gate 過得了的 factor 才併入 pool）

---

### 🟢 第二名：FinMem — Layered Memory for LLM Trading Agent

**Repo**：https://github.com/pipiku915/FinMem-LLM-StockTrading
**Paper**：ICAIF 2024

**核心架構**：3-layer memory
- **Profiling**：agent 個性 / 風格 / 偏好（trader persona）
- **Memory**：
  - Short-term：今日訊號
  - Mid-term：本週事件、已未了結 thesis
  - Long-term：跨季趨勢
- **Decision-making**：從 memory 轉決策

**對我們的差距分析**：
- Debate 目前有 24h KV cache per symbol（`paper:debate:<sym>:<date>`）
- **完全無歷史記憶**：每天遇到同一支股票從 0 開始 debate
- **narrative drift 問題**：Bull 上週說「半導體景氣循環向上」，本週另個 trigger 變成 Bear 說「庫存修正」，agent 不知道自己過去說過什麼

**建議導入方式**：
- 在 `worker/src/lib/debateTrader.ts` 的 `mlContext` 加歷史 thesis 欄位
- 從 `daily_recommendations` 查該 symbol 過去 30 天的 debate summary（已存在 KV cache 中可彙整）
- Bull/Bear 在 prompt 裡看到「這支股票上週 thesis 是 X，今天訊號是否一致 / 已驗證 / 推翻」
- **工作量小**（只動 debateTrader.ts 一個檔案）

**為什麼是第二名**：
- ROI 高、實作門檻低
- 直接解決真實痛點（narrative drift）
- 不需新基建

---

### 🟢 可考慮：Trading-R1 — RL-trained Trading LLM

**Repo**：https://github.com/TauricResearch/TradingAgents
**Paper**：[arXiv 2509.11420](https://arxiv.org/abs/2509.11420)（2025/09）

**核心**：
- 100K+ 財金推理樣本上 SFT + 漸進式 RL
- 涵蓋 14 主要 ticker、技術 + 基本 + 新聞 + insider sentiment + macro
- 輸出：thesis composition + facts-grounded analysis + volatility-adjusted decision

**對我們的差距**：Debate Fulcrum 用通用 Gemini Flash Lite / Claude Haiku — **無 trading-specific 微調**

**建議**：
- 可包成 endpoint 取代 debate 3-tier fallback 中的 Gemini 層
- 主要風險：**訓練資料是美股英文**，台股效度待驗證
- 必須先做 shadow mode（debate 跑兩個 model，記錄 conviction 差異）2-4 週再決定

**為什麼不是優先**：訓練資料 mismatch 風險高，先做需要大量驗證

---

### 🟡 邊際收益：Chronos-2 / Moirai-2 / TimesFM 2.5 升級

**核心**：Time-series Foundation Models 進入 multivariate 時代
- Chronos-2（Amazon 2025 底）：multivariate
- Moirai-2（Salesforce）：any-variate attention 天然捕捉 cross-series
- TimesFM 2.5（Google）：參數效率提升

**對我們的差距**：
- `ml-service/app/ensemble.py` 用的應該是 Chronos v1（univariate）
- 跨股票關聯只靠 FT-Transformer + GNN shadow

**建議**：🟡 **有餘力再做** — 我們 ensemble 11 個 model，Chronos 只佔 1 席。升級只提升 1/11 的貢獻；retrain + 驗證成本不見得合算。

---

### 🟡 工程參考：NautilusTrader

**Repo**：https://github.com/nautechsystems/nautilus_trader
**核心**：Rust core、event-driven、5M rows/sec、nanosecond resolution

**評估**：
- 我們 `ml-controller/services/backtest_engine.py` 是純 Python
- NautilusTrader 速度快很多但**替換成本太大**
- 🟡 **不替換**，但可參考其 event-loop 架構

---

### 🔴 不採納

| 項目 | 為什麼不 |
|------|---------|
| **AlphaAgent**（SUSTech）| QuantaAlpha 是 superior version |
| **FinGPT**（sentiment LLM）| 我們 PTT + concept_buzz 已覆蓋中文情緒 |
| **FinRL 原版**（DRL）| 我們 `rl_shadow.py` 已有 DQN 等價設計 |
| **vectorbt / backtrader**（backtest）| 已有自己的 backtest_engine |
| **CrewAI / AutoGen**（agent framework）| 已用 LangGraph |
| **TradingAgents**（已分析過）| 已啟發 Phase 4 multi-round debate（PR #6）|

---

## 推薦執行順序

如果要做 ABCD 排序：

### Sprint 1（最高 ROI，2-3 週）
**LLM Factor Mining Service（QuantaAlpha 風格）**

- [ ] 新模組 `ml-controller/services/alpha_mining_service.py`
- [ ] LLM prompt: 給定 base data schema（OHLCV + indicators + chip + margin），提出新 factor 假設
- [ ] LLM 生成 Polars expression 計算 factor
- [ ] 跑 walk-forward backtest（reuse `app/wfe.py` gate）
- [ ] 通過 `min_wfe_score >= 1.0` 的 factor 加入 `feature_pool.json` 候選池
- [ ] 月度 retrain 時自動評估候選池並併入活躍 features
- [ ] 新 cron `0 16 1-7 * 6`（與 monthly retrain 同步）
- [ ] **預期效益**：每月發現 3-5 個新 alpha factor，IC 平均 > 0.05

### Sprint 2（小工作量，2-3 天）
**FinMem 分層記憶接進 debate**

- [ ] 在 `worker/src/lib/debateTrader.ts` 加 `loadHistoricalThesis(symbol, lookbackDays=30)`
- [ ] 從 KV `paper:debate:<sym>:<date>` 過去 30 天彙整 summary
- [ ] mlContext 新增 `historical_thesis` 段落
- [ ] Zealot/Reaper prompt 加：「過去 thesis 是 X，今日驗證 / 推翻 / 維持？」
- [ ] **預期效益**：減少 narrative drift；連續持倉 thesis 一致性提升

### Sprint 3（驗證類，2 週 shadow mode）
**Trading-R1 shadow integration**

- [ ] 包 Trading-R1 endpoint（HuggingFace inference 或 self-host）
- [ ] Debate 跑 dual-model：原 Fulcrum + Trading-R1
- [ ] D1 新表 `debate_dual_log` 記錄兩邊 conviction & verdict
- [ ] 2 週後比對 D-2 verify 結果，看哪個 verdict 跟實際 PnL 相關性高
- [ ] 通過則 swap

### Sprint 4（如有餘力）
**Chronos-2 ensemble 升級** — Modal 重新訓練 Chronos-2 model，加進 ensemble vote

---

## 給下個 Session 的具體 prompt 建議

如果要直接接手做 Sprint 1：

```
Branch base: main（PR #6 merge 後）
任務: 實作 QuantaAlpha 式 LLM factor mining

步驟:
1. 讀 ml-controller/services/persona_service.py 模仿其架構
2. 讀 ml-service/app/wfe.py 了解 gate 介面（Sprint 1 會 reuse）
3. 新模組: ml-controller/services/alpha_mining_service.py
   - propose_factor(base_features, market_context) -> str (Polars expression)
   - validate_factor(expression, historical_data) -> WFEGateResult
   - mine_alpha_factors(n_iterations=20) -> list[ApprovedFactor]
4. 新 D1 table: alpha_factor_candidates
5. LangGraph node: node_mine_alpha_factors（月度觸發）
6. 通過 gate 的 factor 寫到 feature_pool.json 的 candidate pool
7. 寫 unit test（mock LLM response，固定 expression 驗 gate 行為）

文獻 anchor: arXiv 2602.07085 (QuantaAlpha)
不要做的事: 直接接到 production scoring；先當 audit tool，user 確認效果再 wire 進 ensemble
```

---

## Sources

- [QuantaAlpha GitHub](https://github.com/QuantaAlpha/QuantaAlpha) | [Paper](https://arxiv.org/abs/2602.07085)
- [FinMem GitHub](https://github.com/pipiku915/FinMem-LLM-StockTrading)
- [Trading-R1 paper](https://arxiv.org/abs/2509.11420) | [TradingAgents GitHub](https://github.com/TauricResearch/TradingAgents)
- [TimeCopilot (30+ TS-FM unified)](https://github.com/TimeCopilot/timecopilot)
- [Moirai / uni2ts (Salesforce)](https://github.com/SalesforceAIResearch/uni2ts)
- [NautilusTrader](https://nautilustrader.io/)
- [FinRL-X (next-gen FinRL)](https://github.com/AI4Finance-Foundation/FinRL-Trading)
- [Awesome-LLM-Quantitative-Trading-Papers](https://github.com/Tom-roujiang/Awesome-LLM-Quantitative-Trading-Papers)
- [awesome-systematic-trading](https://github.com/wangzhe3224/awesome-systematic-trading)
- [FinGPT](https://github.com/AI4Finance-Foundation/FinGPT)
