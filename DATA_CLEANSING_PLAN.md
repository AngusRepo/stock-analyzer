# Screener 資料清洗與候選篩選升級計畫

> 日期：2026-04-02
> 問題：screener 篩出 ~45 檔喂 ML，資料清洗度不夠，導致 ML timeout 和雜訊

---

## 一、現況分析

### 現有 screener 流程

```
全市場 OHLCV + Chips
     │
     ▼
Step 1: Concept Heat Score → top 8 概念族群
     │
     ▼
Step 2: filterCandidates() → per-stock 評分 0~108
        排除：股價 < 15、日均量 < 30 萬、5日跌 > 10%
        評分：相對強度 + 法人連買 + RSI + 量能 + MA20 + 肯特納
     │
     ▼
Step 3: 放寬加入 hot concept 所有成員（只過濾股價 < 10）
     │
     ▼
Step 4: 動量突破掃描（量能爆發 + 價格突破，不靠概念標籤）
     │
     ▼
Step 5: 排除處置股
     │
     ▼
~45 檔 → D1 → ML pipeline
```

### 問題

1. **Step 3 太鬆**：hot concept 成員幾乎全加入，只檢查股價 > 10
2. **無異常值處理**：OHLCV 的極端值（如某天量能異常放大 10 倍）直接進入評分
3. **同族群同質股多**：同一概念內走勢幾乎一樣的股票佔用 ML 額度
4. **ML timeout**：45 檔 × 10 模型 ensemble → Modal 偶爾 timeout

---

## 二、清洗方案

### Phase 1：基礎清洗（最優先）

#### 1.1 缺值規則（Missing Value Rules）

**目標**：過濾資料不完整的候選

**規則**：
- 至少 3 天有效 price data（close > 0 且 volume > 0）
- 缺值比例 > 40% 直接排除
- 最新一天的 close 和 volume 必須有值

**實作位置**：`worker/src/lib/dataCleanser.ts`（新檔案）

**我的看法**：這是最基本的，現在 filterCandidates 有 `prices.length < 3` 檢查但 Step 3 放寬加入的候選沒有，應該統一到清洗層。

---

#### 1.2 Hampel Filter（時序異常偵測）

**目標**：偵測 OHLCV 中的離群值（如某天價格/量能異常跳動）

**原理**：
- 用 rolling median 取代 rolling mean（不受極端值影響）
- MAD (Median Absolute Deviation) 取代標準差
- 異常判定：`|x_i - median| > k × 1.4826 × MAD`（k=3）

**適用資料**：
| 資料類型 | 應用方式 |
|---------|---------|
| OHLCV close | 偵測異常收盤價（如除權息日未調整） |
| Trading_Volume | 偵測異常量能（如大宗交易造成的假量） |

**處理方式**：
- 偵測到異常 → 用 median 替代（不刪除整筆資料）
- 超過一半天數是異常 → 排除該候選

**實作位置**：`worker/src/lib/dataCleanser.ts`

**我的看法**：Hampel 對金融時序是最穩的異常偵測方式。z-score 用 mean+std，一個極端值就會拉偏全部；Hampel 用 median+MAD，天生抗極端值。window_size=2（5 天窗口）對你的 5 日資料剛好。

**程式碼參考**：

```typescript
function hampelFilter(
  values: number[],
  windowSize: number = 2,
  k: number = 3,
): { cleaned: number[]; outlierIndices: number[] } {
  const n = values.length
  const cleaned = [...values]
  const outlierIndices: number[] = []

  if (n < 2 * windowSize + 1) return { cleaned, outlierIndices }

  for (let i = windowSize; i < n - windowSize; i++) {
    const window = values.slice(i - windowSize, i + windowSize + 1)
    const sorted = [...window].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]

    const deviations = window.map(v => Math.abs(v - median)).sort((a, b) => a - b)
    const mad = deviations[Math.floor(deviations.length / 2)]

    const threshold = k * 1.4826 * mad

    if (threshold > 0 && Math.abs(values[i] - median) > threshold) {
      cleaned[i] = median
      outlierIndices.push(i)
    }
  }
  return { cleaned, outlierIndices }
}
```

---

#### 1.3 Winsorization（極端值截斷）

**目標**：壓平跨候選的極端分數，避免一檔超高分壟斷

**原理**：
- 不刪除資料，只把超出 [5th, 95th] percentile 的值截斷到邊界
- 比簡單 clamp 更統計學正確

**適用資料（分資料類型）**：

| 資料類型 | Winsorize 方式 |
|---------|---------------|
| OHLCV / 技術特徵 | Hampel 先清 → Winsorize percentile clip |
| Sentiment / PTT buzz | log transform → robust z-score → source-wise normalization |
| Chips 籌碼 | rolling median + MAD → percentile clip (2nd/98th，金融數據本來偏態) |
| Candidate scores | Winsorize 0.05/0.95 |

**實作位置**：`worker/src/lib/dataCleanser.ts`

**我的看法**：Winsorize 要分資料類型處理。OHLCV 用標準 percentile clip；籌碼資料本來就偏態分布（外資某天大買 50 億是正常的），所以要用更寬的 percentile（2%/98%）；PTT buzz 是 count data，先 log transform 再 normalize 才合理。

**程式碼參考**：

```typescript
function winsorize(
  values: number[],
  lowerPct: number = 0.05,
  upperPct: number = 0.95,
): { winsorized: number[]; clippedCount: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const lowerBound = sorted[Math.floor(sorted.length * lowerPct)]
  const upperBound = sorted[Math.ceil(sorted.length * upperPct) - 1]

  let clippedCount = 0
  const winsorized = values.map(v => {
    if (v < lowerBound) { clippedCount++; return lowerBound }
    if (v > upperBound) { clippedCount++; return upperBound }
    return v
  })
  return { winsorized, clippedCount }
}
```

---

#### 1.4 Sector/Group 去重（同質候選剔除）

**目標**：同一概念族群內，走勢幾乎一樣的股票只留最高分

**規則**：
- 同 sector 內，5 日報酬率差距 < 1% 且分數差 < 5 → 視為同質，只留最高分
- 每個 sector 最多保留 6 檔

**實作位置**：`worker/src/lib/dataCleanser.ts`

**我的看法**：這是最直接解決「45 檔太多」的方法。同一個概念族群（如 AI 伺服器）裡面可能有 10 檔走勢幾乎一模一樣的股票，全送 ML 是浪費。Phase 2 可以用 DBSCAN/HDBSCAN 做更精準的分群去重。

---

#### 1.5 Rule-based Pre-ML Score（門檻篩選）

**目標**：在送 ML 之前做一次粗篩，直接解 timeout

**評分維度（0-100 快速粗分）**：

| 維度 | 分數範圍 | 邏輯 |
|------|---------|------|
| 基本趨勢方向 | 0-30 | 5 日跌幅 > 15% = 0 分；不跌 = 20+漲幅加分 |
| 量能活絡 | 0-20 | 均量 < 10 萬 = fail；> 30 萬 = 20 分 |
| 收盤合理性 | 0-10 | 日內振幅 > 9.5%（漲跌停）= 扣分 |
| 籌碼方向 | 0-20 | 近 3 日法人淨買超 > 0 = 20 分 |
| Screener 分數 | 0-20 | screenScore / 5 |

**通過條件**：score >= 25 且無致命 failReason

**實作位置**：`worker/src/lib/dataCleanser.ts`

**我的看法**：這不是要取代 ML，而是用簡單規則先砍掉「明顯不該送 ML 的」候選。例如：5 日跌 20% 且法人大賣的股票，不管 concept heat 多高都不該浪費 ML 算力。

---

### Phase 2：智慧分流（第二優先）

#### 2.1 DBSCAN/HDBSCAN 候選分群

**目標**：取代 Phase 1 的簡易去重，做更精準的同質候選識別

**特徵向量**：
- 5 日報酬率
- 量能比
- RSI
- 法人買超天數
- sector one-hot

**做法**：
- 用 HDBSCAN 分群（不需指定 k）
- 每個 cluster 只取代表股（分數最高）
- noise points（不屬於任何 cluster）= 獨特標的，保留

**實作位置**：`ml-controller/services/` 或 `worker/src/lib/`

**我的看法**：DBSCAN 比簡單 dedup 好在它能自動發現「非顯而易見的同質股」。例如兩檔不在同一 sector 但走勢完全一樣（如同一供應鏈的上下游），簡易 dedup 抓不到但 DBSCAN 可以。缺點是要在 Worker 裡跑或丟給 Controller 做，Worker CPU 有限。

**建議放在 ml-controller**（Python，HDBSCAN 套件現成）。

---

#### 2.2 Isolation Forest anomaly_score

**目標**：補一個不依賴 domain knowledge 的異常偵測

**用途**：
- 幫每個候選算一個 anomaly_score (0~1)
- 不直接排除，而是作為 ML 的額外特徵
- 或作為 pre-ranker 的降分依據

**實作位置**：`ml-controller/services/`（Python，sklearn 現成）

**我的看法**：Isolation Forest 跟 Hampel 的差異：Hampel 是「同一個變數的時序異常」，IF 是「多維度空間中的離群點」。兩者互補。IF 的 anomaly_score 可以直接塞進 scorer.py 當作一個 penalty factor。

---

#### 2.3 LightGBM Pre-ranker

**目標**：用簡單 ML 模型做 pre-ranking，取代 rule-based score

**訓練資料**：
- 特徵：screener score、chip 指標、技術指標、anomaly_score
- Label：後續 ML ensemble 的預測方向是否正確（回測可得）

**做法**：
- 訓練一個輕量 LightGBM binary classifier
- 輸出 probability → 作為 pre-rank score
- 取 top 25 送 ML ensemble

**實作位置**：`ml-controller/services/`

**我的看法**：這要等有足夠回測資料才能訓練（至少 2-3 個月的 screener 結果 + ML 預測對錯）。Phase 1 先跑，累積資料後再做 Phase 2。

---

## 三、清洗 Pipeline 插入位置

```
全市場 OHLCV + Chips
     │
     ▼
Step 1: Concept Heat → top 8 概念
     │
     ▼
Step 2: filterCandidates() → 評分篩選
     │
     ▼
Step 3: 放寬加入 concept 成員
     │
     ▼
Step 4: 動量突破掃描
     │
     ▼
Step 4.5: 排除處置股
     │
     ▼
★ Step 4.6: 資料清洗 pipeline（新增）★
│   ├ 缺值規則
│   ├ Hampel Filter（price + volume）
│   ├ Winsorization（分資料類型）
│   ├ Sector 去重
│   └ Pre-ML Score（門檻 ≥ 25）
│   → 目標：45 → 25 檔
     │
     ▼
Step 5: 寫入 D1 → ML pipeline
```

### 新增檔案

```
worker/src/lib/
  └── dataCleanser.ts    # Phase 1 清洗模組

ml-controller/services/
  ├── candidate_filter.py   # Phase 2 HDBSCAN + IF（未來）
  └── pre_ranker.py         # Phase 2 LightGBM（未來）
```

### 對 marketScreener.ts 的改動

在 Step 4.5（處置股排除）後、Step 5（DB 寫入）前，插入一行：

```typescript
// Step 4.6: 資料清洗
const { cleanseAndFilter } = await import('./dataCleanser')
const cleansed = cleanseAndFilter(candidates, data.prices, data.chips, 25)
candidates.length = 0
candidates.push(...cleansed.candidates)
```

---

## 四、預期效果

| 指標 | 現在 | Phase 1 後 | Phase 2 後 |
|------|------|-----------|-----------|
| ML 候選數量 | ~45 | ~25 | ~20 |
| ML timeout 頻率 | 偶發 | 應消除 | — |
| 同質候選 | 多 | 減少（簡易 dedup） | 消除（HDBSCAN） |
| 極端值污染 | 有 | Hampel + Winsorize 處理 | + IF anomaly_score |
| 缺值候選 | 會進入 ML | 被過濾 | — |

---

## 五、清洗報告 Log 格式

每次執行後輸出：

```
[Screener] Data cleansing: 45 → 23 candidates
  ├ Missing data: -3 (1234, 5678, 9012)
  ├ Hampel outlier: -1 (3456)
  ├ Sector dedup: -8 (2345, 6789, ...)
  ├ Pre-ML filter: -10 (7890, ...)
  └ Winsorized: 4 scores clipped
```

---

## 六、導入順序

| 順序 | 項目 | 前置條件 | 預估工時 |
|------|------|---------|---------|
| 1 | Hampel Filter | 無 | 1h |
| 2 | Winsorization | 無 | 0.5h |
| 3 | Pre-ML Score | 無 | 1h |
| 4 | 缺值規則 | 無 | 0.5h |
| 5 | Sector 去重 | 無 | 1h |
| 6 | DBSCAN/HDBSCAN | Phase 1 完成 + Controller Python 環境 | 2h |
| 7 | Isolation Forest | Phase 1 完成 | 1h |
| 8 | LightGBM Pre-ranker | 2-3 個月 screener 回測資料 | 3h |
