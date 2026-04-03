# Pump-and-Fade 過濾與 Trend Quality 評估：業界做法調研

> 調研日期：2026-04-03

---

## 1. 主流 Trading Bot 如何過濾 Pump-and-Fade

### QuantConnect (Lean Engine)

**Universe Selection 層級過濾（第一道防線）：**
- **Dollar Volume Filter**: 要求 DollarVolume > $10M（保守）或 > $1B（激進），排除低流動性標的
- **Market Cap Filter**: 常見門檻 $5B+，排除小型股（容易被拉抬）
- **Price Filter**: 股價 > $10，避免 penny stock
- 典型做法：按 DollarVolume 降序排列，取前 50 檔

**策略層級過濾：**
- QuantConnect 支援 Indicator Universe，可在 Universe Selection 階段就用技術指標過濾
- 常見組合：ADX > 25 + Volume 確認 + Price > SMA(200)

### Freqtrade

**內建風控機制：**
- **ROI Table**: 定義時間衰減的最低報酬率，例如 `{"0": 0.04, "30": 0.02, "60": 0.01}` — 持倉越久，接受越低的報酬就出場
- **Trailing Stoploss**: 動態追蹤止損，鎖住利潤同時限制回撤
- **Custom Stoploss Callback**: 每個 tick 都可重新計算止損，可實作 spike detection 邏輯
- **Protection 機制**: `StoplossGuard`、`MaxDrawdown`、`CooldownPeriod` 等內建保護

**社群常見 Pump 過濾策略：**
- 檢查 volume spike ratio: `volume / volume_sma(20) > 3` 時視為異常
- RSI > 80 + volume spike = 不進場
- 要求 volume 連續 N 根 K 棒都在 SMA 之上（持續性確認）

### Alpaca / 3Commas

- Alpaca 提供 API，策略由用戶自建，常見做法是用 `bars` endpoint 取量價資料後自行過濾
- 3Commas 使用 DCA (Dollar Cost Averaging) Bot + Signal-based entry，社群建議搭配 TradingView alert 過濾假信號

---

## 2. Trend Quality vs Noise 的關鍵指標

### 核心指標

| 指標 | 公式/參數 | 用途 | 閾值 |
|------|-----------|------|------|
| **ADX** (Average Directional Index) | Wilder, period=14 | 趨勢強度 | > 25 = 強趨勢, < 20 = 無趨勢 |
| **Kaufman Efficiency Ratio (ER)** | `ER = abs(Close[0] - Close[N]) / SUM(abs(Close[i] - Close[i-1]))` | 趨勢品質 vs 雜訊 | 1.0 = 完美趨勢, 0 = 純雜訊 |
| **RSI** | period=14 | 超買超賣 | > 70 超買, < 30 超賣 |
| **Bollinger Band Width** | `(Upper - Lower) / Middle` | 波動率 | 用於判斷是否在 squeeze |
| **ATR** (Average True Range) | period=14 | 波動幅度 | 用於動態止損: 1.5x ATR（正常）, 2x ATR（高波動）|

### Kaufman Efficiency Ratio — 最直接的 Trend Quality 指標

**公式：**
```
ER = 100 * (Close - Close[N]) / SUM(abs(Close[i] - Close[i-1]), i=1..N)
```
- N 常用 10 或 20
- **高 ER（接近 100）**: 價格朝同一方向穩定移動 = 真趨勢
- **低 ER（接近 0）**: 價格雜亂震盪 = pump-and-fade 或噪音
- Kaufman 在其 KAMA (Kaufman Adaptive Moving Average) 中用此 ratio 來自動調整 MA 的靈敏度

**應用於 Pump-and-Fade 偵測：**
- 股票短期急漲但 ER 很低 → 漲幅來自劇烈震盪而非持續方向 → 高機率是假突破
- 股票穩定上漲且 ER 高 → 趨勢品質好 → 適合追蹤

### Volume 確認指標

| 指標 | 用途 | Pump-and-Fade 信號 |
|------|------|-------------------|
| **OBV** (On-Balance Volume) | 累積量能方向 | OBV 與價格背離 = 趨勢不可靠 |
| **VWAP** | 當日均價基準 | 價格遠離 VWAP = 可能回歸 |
| **CMF** (Chaikin Money Flow, period=20) | 資金流向 | CMF < 0 但價格上漲 = 假突破 |
| **Volume Ratio** | `Volume / SMA(Volume, 20)` | > 3x 可能是異常 spike |

### Mean Reversion 角度的 Spike 偵測

- **Price > 1.5 Std Dev from Mean**: 統計上過度偏離，高機率回歸
- **RSI > 70 + Volume Spike**: 經典的 pump-and-fade 預警組合
- **Bollinger Band 上軌突破 + CMF 負值**: 價格突破但資金並未跟上

---

## 3. 機構量化基金公開討論的 Stock Screening 因子

### AQR Capital Management（公開研究最多）

AQR 管理 $179B，公開發表了大量因子研究論文：

**四大核心因子：**

1. **Value**:
   - HML (High Minus Low) — Fama-French 傳統價值因子
   - AQR 改進版: "HML Devil"（Asness & Frazzini, 2013）— 使用更即時的帳面價值

2. **Momentum**:
   - 12-1 month momentum（過去 12 個月報酬，排除最近 1 個月）
   - "Factor Momentum"（2019）— Sharpe Ratio 達 0.84
   - 論文: "Value and Momentum Everywhere" — 在 8 個市場/資產類別都有效

3. **Quality**:
   - "Quality Minus Junk"（Asness, Frazzini, Pedersen, 2014）
   - 複合 Quality 因子包含：Profitability、Growth、Safety、Payout
   - **這是過濾 pump-and-fade 的最佳因子之一** — 高品質公司不容易被短期炒作

4. **Low Beta / BAB**:
   - "Betting Against Beta"（Frazzini & Pedersen, 2014）
   - 低 beta 股票風險調整後報酬更高

### Renaissance Technologies

- 極度保密，幾乎不公開方法論
- 已知使用：統計套利、mean reversion、非線性模型、alternative data
- Medallion Fund 年化報酬 ~66%（費前），但方法不可複製

### Two Sigma

- 使用 ML/AI 驅動的量化策略
- 處理大量 alternative data（衛星圖像、社群媒體、信用卡資料等）
- 公開發表的研究偏向 ML methodology 而非具體交易因子

### 對 StockVision 的啟示

**可直接採用的因子篩選：**
- Quality factor（Profitability + Growth stability）→ 排除基本面差的標的
- Momentum 12-1（排除最近 1 個月避免 mean reversion 風險）
- Dollar Volume / Liquidity 門檻 → 排除容易被操縱的低流動性標的

---

## 4. 台股特有的 Pump-and-Fade 過濾技術

### 台股三大法人（機構）籌碼分析

台股最大特色是 **籌碼資料完全公開**，這在全球市場中相當少見：

**三大法人：**
- **外資 (Foreign Investors)**: 買賣超資料每日公佈（TWSE T86 報表）
- **投信 (Investment Trust)**: 本土法人，常被視為「聰明錢」
- **自營商 (Dealers)**: 短線操作為主

**過濾假突破的籌碼條件：**
1. **外資 + 投信同步買超**: 單一法人買超可能是避險或短線操作，雙法人同步買超可信度高
2. **連續買超天數 ≥ 3**: 排除單日脈衝式買盤
3. **買超張數 vs 成交量比**: 法人買超佔當日成交量 > 10% 才算有意義
4. **外資持股比例變化**: 持續增加 vs 單次大買

### XQ 全球贏家平台的趨勢檢定器

XQ 平台提出的「趨勢檢定器」概念，用以下指標組合判斷趨勢真假：
- 總成交筆數是否增加
- 佔全市場總成交量的比重是否增加
- 外盤（主動買進）的佔比是否增加
- 主力是否買超
- 波動幅度是否變大
- 開盤委買是否增加

### MultiCharts 台股特有指標

- **MasterForce (BV-AV)**: 用即時委買/委賣量差值判斷主力動向
- **DealtForce (TA-TB)**: 用多空單累計成交量差值計算實際成交力道

### TEJ (台灣經濟新報) 量化資料

TEJ 提供台股專用的量化資料 API，包含：
- 基本面、技術面、財務面、籌碼面共 900+ 種資料欄位
- 支援策略回測

---

## 5. 低流動性 + 法人買盤 Spike 的處理

### 問題定義

低流動性標的被法人（尤其外資）大量買入時，容易出現：
- 短期暴漲（供需失衡）
- 之後快速回落（法人買完就沒有後續買盤）
- 散戶追高被套

### 機構演算法的做法

**Liquidity-Seeking Algorithm（流動性搜尋演算法）：**
- 機構大單拆成小單，分散在時間軸上執行
- 不以市價單成交，而是在 bid/ask 附近掛限價單
- 目標是不讓市場察覺到大單存在

**Volume Spike 偵測指標：**
- Quote Rate > 5000/sec 且持續數秒 → 有程式交易介入的信號
- 價格短時間內顯著移動 → 可能是機構演算法正在執行

### 建議的過濾策略

**進場前過濾：**
1. **日均成交量門檻**: 至少 500 張/日（台股），排除極低流動性
2. **Volume Spike Ratio**: `today_volume / avg_volume_20d > 5` 且 **無基本面事件** → 標記為可疑
3. **Price Impact Ratio**: `abs(price_change%) / volume_ratio` — 少量成交就造成大幅價格變動 = 低流動性 spike

**進場後風控：**
1. **Trailing Stop**: 使用 2x ATR 作為動態止損
2. **Time Decay Exit**: 若 N 天內未繼續上漲，強制減倉
3. **Volume Confirmation**: 突破後 3 天內成交量必須維持在 SMA(20) 之上

---

## 6. 綜合建議：StockVision 可採用的 Pump-and-Fade Filter

### Layer 1: Universe Filter（選股池過濾）
- 日均成交金額 > 台幣 5000 萬
- 股本 > 20 億（排除微型股）
- 近 20 日平均成交量 > 500 張

### Layer 2: Trend Quality Gate（趨勢品質閘門）
- **Kaufman ER(10) > 0.3**: 確認有方向性趨勢
- **ADX(14) > 20**: 趨勢存在
- **CMF(20) > 0**: 資金流入確認

### Layer 3: Pump Detection（拉抬偵測）
- Volume Spike Ratio > 3x 且 ER < 0.2 → **標記為疑似 pump**
- 單日漲幅 > 1.5 Std Dev 且 CMF < 0 → **標記為假突破**
- RSI > 75 且外資/投信未同步買超 → **缺乏法人支撐的急漲**

### Layer 4: 台股籌碼確認
- 外資 + 投信連續買超 ≥ 3 天
- 法人買超張數佔成交量 > 10%
- 融資餘額未同步大增（散戶追高指標）

---

## Sources

- [QuantConnect Universe Selection Docs](https://www.quantconnect.com/docs/v2/writing-algorithms/universes/key-concepts)
- [QuantConnect Liquidity Universes](https://www.quantconnect.com/docs/v2/writing-algorithms/universes/equity/liquidity-universes)
- [Freqtrade Strategy Customization](https://www.freqtrade.io/en/stable/strategy-customization/)
- [Freqtrade Stoploss Docs](https://www.freqtrade.io/en/stable/stoploss/)
- [Charles Schwab: ADX and RSI](https://www.schwab.com/learn/story/spot-and-stick-to-trends-with-adx-and-rsi)
- [Fidelity: ADX](https://www.fidelity.com/viewpoints/active-investor/average-directional-index-ADX)
- [AQR: Value and Momentum Everywhere](https://www.aqr.com/Insights/Datasets/Value-and-Momentum-Everywhere-Factors-Monthly)
- [AQR: Factor Momentum Everywhere](https://www.aqr.com/Insights/Research/Working-Paper/Factor-Momentum-Everywhere)
- [AQR: Quality Minus Junk (PDF)](https://www.aqr.com/-/media/AQR/Documents/Journal-Articles/JPM-Fact-Fiction-and-Momentum-Investing.pdf)
- [AQR: Factor Investing](https://funds.aqr.com/Insights/Strategies/Understanding-Factor-Investing)
- [Kaufman Efficiency Ratio - TrendSpider](https://trendspider.com/learning-center/kaufman-efficiency-ratio/)
- [Kaufman Efficiency Ratio - QuantShare](https://www.quantshare.com/item-869-kaufman-s-efficiency-ratio-fractal-efficiency)
- [LuxAlgo: Mean Reversion Strategies](https://www.luxalgo.com/blog/mean-reversion-strategies-for-algorithmic-trading/)
- [Volume Indicators - AlgoTradingLib](https://algotradinglib.com/en/pedia/v/volume_indicators.html)
- [XQ 趨勢檢定器](https://www.xq.com.tw/xstrader/%E8%B6%A8%E5%8B%A2%E6%AA%A2%E5%AE%9A%E5%99%A8/)
- [TEJ 程式交易](https://www.tejwin.com/insight/program-trading/)
- [量化通 QuantPass](https://quantpass.org/what-is-program-trading/)
- [TWSE 三大法人買賣超日報](https://www.twse.com.tw/zh/trading/foreign/t86.html)
- [Proof Trading: Liquidity Seeker Algorithm](https://medium.com/prooftrading/building-a-new-institutional-trading-algorithm-aggressive-liquidity-seeker-6bc2caf9dd)
- [Renaissance & AQR Factor Models (Medium)](https://medium.com/@navnoorbawa/how-renaissance-technologies-aqr-and-pdt-built-100-billion-factor-models-statistical-arbitrage-ac0c9cd8a518)
