# Screener 重構計畫：Bottom-up 多因子 + RRG 產業輪動

> 日期：2026-04-02
> 狀態：規劃中
> 核心變更：從 top-down（先選概念族群）翻轉為 bottom-up（先評個股）

---

## 一、現況問題

### 現有流程（top-down）

```
概念族群熱度 top 8 → 從族群內挑個股 → 放寬加入族群所有成員 → ~45 檔
```

### 問題

1. **概念族群是入口門檻**：不在 hot concept 裡的好股票直接被排除
2. **Step 3 放寬太鬆**：hot concept 成員幾乎全加入（只過濾股價 < 10）→ 膨脹主因
3. **概念標籤是手動維護的**（`seed_concept_tags.py` 28 個概念）→ 不準、不即時
4. **新聞情緒沒用到**：`news.ts` 有鉅亨網 + Yahoo 爬蟲但 screener 沒接
5. **RRG 沒接入**：前端有 RRG 四象限圖但 screener 沒用

### 業界共識

- 板塊配置只貢獻 9% 報酬（vs 個股選擇 12%）
- 量化系統主流是 bottom-up 多因子為主，top-down 為輔
- 報酬率聚類比 GICS/概念標籤更準（RMSE 低 15.9%）
- 台股概念股分類全部是人工維護（CMoney、Goodinfo、鉅亨網皆是）

---

## 二、重構後完整流程

```
Step 1: Universe 定義（全市場流動性門檻）
│
│   資料來源：
│   ├── TWSE/TPEx 全市場 20 日 OHLCV
│   ├── 三大法人籌碼
│   ├── 鉅亨網 + Yahoo 新聞
│   └── PTT 熱門概念
│
│   產業分類：FMStockInfo.industry_category
│   ├── TWSE 上市：33 類
│   ├── TPEx 上櫃：30 類
│   └── 合計約 38 個不重複產業別（OpenAPI 直接取得，不需維護）
│
│   Hard filter：
│   ├── close >= 15
│   ├── close <= 2000
│   ├── 20 日均量 >= 300,000
│   ├── 最新日 volume > 0
│   └── 排除處置股（punishedSet）
│
│   → ~800-1000 檔通過，每檔自帶官方產業別
│
      ▼
Step 2: 多因子評分（Bottom-up 主篩選，每檔獨立評分）
│
│   籌碼面 (0-40)：
│   ├── 外資+投信 5 日淨買超量 → 分級給分
│   │   > 10 億 = 36, > 5 億 = 28, > 2 億 = 20, > 0 = 12, > -2 億 = 5, else 0
│   └── 法人連續買超天數
│       >= 5 天 +4, >= 3 天 +2
│
│   技術面 (0-30)：
│   ├── RSI 14：55-70 = 12, 50-55 = 8, 45-50 = 4, >70 = 5
│   ├── MACD histogram：> 0 = +8, > -0.5 = +3
│   ├── 均線排列：MA5 +3, MA20 +4, MA60 +3
│   └── 肯特納通道突破：close > MA20 + 1.5×ATR = +6
│
│   動能面 (0-20)：
│   ├── 5 日報酬率 vs 大盤 (0-10)
│   ├── 量能比：近 3 日 vs 20 日均量 (0-7)
│   └── RSI 鈍化：RSI > 80 連 3+ 天 = +3
│
│   → 每檔得到 base_score (0-90)
│
      ▼
Step 3: RRG 產業輪動定位（官方 38 產業別）
│
│   RS-Ratio 計算：
│   ├── 每個產業的成員市值加權平均報酬（20 日窗口）
│   ├── ÷ 大盤（TWII/TPEx）同期報酬
│   └── EMA(10) 平滑 × 100（100 = 與大盤同步）
│
│   RS-Momentum 計算：
│   └── RS-Ratio(today) - RS-Ratio(10 days ago)
│
│   四象限分類 + 加分：
│   ├── Leading   (Ratio > 100, Momentum > 0) → +10 分
│   ├── Improving (Ratio < 100, Momentum > 0) → +7 分
│   ├── Weakening (Ratio > 100, Momentum < 0) → +0 分
│   └── Lagging   (Ratio < 100, Momentum < 0) → -5 分
│
│   每檔股票依其官方產業別獲得 RRG bonus/penalty
│
│   注意：38 類粒度足夠。RRG 看的是「產業層級的順逆風」，
│   個股層級的精細度由 Step 2 多因子 + Step 5 報酬率聚類補足。
│
      ▼
Step 4: 情緒面加分（多源彙整）
│
│   新聞情緒 bonus (0-10)：← 現有 news.ts，目前 screener 沒接
│   ├── 鉅亨網 RSS → analyzeSentiment()
│   ├── Yahoo Finance → analyzeSentiment()
│   └── positive = +5~10, neutral = 0, negative = -5
│
│   PTT buzz bonus (0-5)：← 從主角降為配角
│   └── mentionCount + sentimentAvg → 加分
│
│   概念標籤 bonus (0-5)：← 降為最低權重，不影響選股
│   └── 屬於 hot concept → +3~5（僅前端展示用）
│
│   → total_score = base_score + rrg_bonus + 情緒 bonus (0-120)
│
      ▼
Step 5: 排序 + 去重 + 截斷
│
│   5a. 全部候選按 total_score 排序
│
│   5b. 同產業上限 5 檔
│       用官方產業別（38 類），避免「半導體佔 15 檔」
│
│   5c. 報酬率相關性去重
│       60 日報酬相關性 > 0.8 的只留最高分
│       用 scipy 層次聚類（或 JS 版簡易相關性計算）
│       不需概念標籤，數據驅動
│       → 自動發現「不同產業但走勢一樣」的同質股
│
│   5d. 取 top 25（硬上限）
│
      ▼
Step 6: 資料品質檢查（輕量清洗）
│
│   ├── 缺值：close / volume = 0 或 null → 排除
│   ├── 異常值：單日漲跌 > 10%（非漲跌停日）→ 標記
│   └── 資料時效：超過 1 天 → 排除
│
      ▼
~20-25 檔 → 寫 D1 → ML pipeline（10 模型 Ensemble）
```

---

## 三、分類體系角色對照

| 分類來源 | 數量 | 在流程中的角色 | 維護方式 |
|---------|------|--------------|---------|
| **官方產業別** | TWSE 33 + TPEx 30 ≈ 38 不重複 | Step 3 RRG 計算 + Step 5 同產業上限 | 不需維護，OpenAPI 直接取 |
| **報酬率相關性分群** | 動態（每週變） | Step 5 去重 | 每週自動計算 |
| **概念標籤** | 現有 28 個 | Step 4 輕量加分 + 前端展示 | 偶爾手動更新 |

**選股邏輯不再依賴概念標籤的準確度。**
標籤分錯最多影響 ±5 分（滿分 120），不會決定一檔股票進不進候選。

---

## 四、跟現有流程的差異

| | 現在 | 重構後 |
|---|---|---|
| **架構** | Top-down（概念族群 → 個股） | Bottom-up（個股評分 → 產業加分） |
| **入口** | 先選 8 個 hot concept | 全市場每檔都評分 |
| **概念族群** | 第一道門檻（決定 universe） | 降為 Step 4 加分項（+0~5） |
| **RRG** | 沒有 | Step 3 用官方 38 產業計算四象限 |
| **新聞情緒** | `news.ts` 沒接入 screener | Step 4 鉅亨+Yahoo 情感加分 |
| **PTT** | 概念熱度主來源 (0-30) | 降為輔助 (0-5) |
| **候選膨脹** | 放寬 concept 成員 + 動量 15 檔 → ~45 | top 25 硬截斷，不會膨脹 |
| **動量突破** | 獨立掃描加 15 檔 | 併入 Step 2 動能面，不另外加 |
| **去重** | 沒有 | Step 5 報酬率相關性去重 |
| **資料品質** | 沒有 | Step 6 缺值/異常/時效檢查 |
| **產業分類** | 手動 28 概念標籤 | 官方 38 產業（自動）+ 報酬率聚類（自動） |
| **控制數量** | 靠 topNPerSector × 族群數（不穩定） | top 25 硬截斷（穩定） |

---

## 五、RRG 計算細節

### 資料需求

| 資料 | 來源 | 現有？ |
|------|------|--------|
| 每檔股票的官方產業別 | `FMStockInfo.industry_category` | ✅ 已有 |
| 每檔股票的 20 日 OHLCV | TWSE/TPEx API | ✅ 已有（目前抓 5 日，需擴到 20 日） |
| 大盤指數日報酬 | TWII / TPEx 指數 | ✅ 已有（`usLeading.ts` 有抓） |
| 每檔股票的市值 | TWSE BWIBBU API | ✅ 已有（`twseApi.ts`） |

### 計算步驟

```
1. 每日：計算每個產業的市值加權平均報酬
   industry_return[i] = Σ(stock_return × market_cap) / Σ(market_cap)

2. 每日：計算相對強度
   relative_strength[i] = industry_cumulative_return(20d) / market_cumulative_return(20d)

3. RS-Ratio = EMA(relative_strength, 10) × 100
   → > 100 表示該產業強於大盤

4. RS-Momentum = RS-Ratio[today] - RS-Ratio[10d ago]
   → > 0 表示動能正在增加

5. 四象限 = f(RS-Ratio, RS-Momentum)
```

### DB 變更

`sector_heat` 表新增欄位：

```sql
ALTER TABLE sector_heat ADD COLUMN rs_ratio REAL;
ALTER TABLE sector_heat ADD COLUMN rs_momentum REAL;
ALTER TABLE sector_heat ADD COLUMN quadrant TEXT;  -- 'Leading'|'Improving'|'Weakening'|'Lagging'
```

---

## 六、報酬率相關性去重細節

### 原理

不靠概念標籤判斷「同質股」，直接看價格行為：
- 60 日報酬率相關性 > 0.8 → 視為同質
- 同質群中只留 total_score 最高的

### 實作方式

```
簡易版（Worker TypeScript 可做）：
1. 取每檔候選的 20 日收盤價序列
2. 計算兩兩 Pearson 相關性
3. 相關性 > 0.8 的配對 → 只留分數高的

進階版（Controller Python）：
1. scipy.cluster.hierarchy 層次聚類
2. 自動分群，每群取代表
```

候選 ~50 檔時，兩兩配對 = 50×49/2 = 1,225 次計算，Worker 跑得動。

---

## 七、改動範圍

| 檔案 | 改動 | 大小 |
|------|------|------|
| `marketScreener.ts` | 重構主流程 | 大（核心） |
| `news.ts` | 新增 `batchSentiment(symbols)` | 小 |
| `tradingConfig.ts` | 新增 `maxCandidates: 25`、`maxPerSector: 5` | 小 |
| `finmind.ts` 或 `twseApi.ts` | 擴展抓 20 日資料（目前 5 日） | 小 |
| `schema.sql` + migration | `sector_heat` 加 `rs_ratio`、`rs_momentum`、`quadrant` | 小 |
| `dailyRecommendation.ts` | `sector_flow` 寫入時一併算 RRG 座標 | 中 |
| `scorer.py` | 不動（ML 階段評分邏輯不變） | 無 |

---

## 八、預期效果

| 指標 | 現在 | 重構後 |
|------|------|--------|
| 候選數量 | ~45（不穩定） | ~25（穩定，硬上限） |
| ML timeout | 偶發 | 應消除 |
| 漏選好股票 | 不在 hot concept = 被排除 | 全市場都評分，不會漏 |
| 同質重複 | 多（同概念走勢一樣） | 報酬率去重消除 |
| 新聞情緒 | 沒用到 | 接入加分 |
| RRG 輪動 | 前端有但 screener 沒用 | 接入 Step 3 |
| 分類維護成本 | 手動維護 28 概念 | 官方產業別自動取得 |

---

## 九、實作順序

| 順序 | 項目 | 前置條件 | 說明 |
|------|------|---------|------|
| 1 | 擴展資料抓取到 20 日 | 無 | 改 `fetchMultiDayMarketData(5)` → `(20)` |
| 2 | Step 2 多因子評分 | 順序 1 | 從現有 `filterCandidates` + `scorer.py` 整合 |
| 3 | Step 3 RRG 計算 | 順序 1 | 新增 RRG 計算函式 + DB migration |
| 4 | Step 4 接入 `news.ts` | 無 | 呼叫現有 `analyzeSentiment` |
| 5 | Step 5 去重 + 截斷 | 順序 2 | 報酬率相關性計算 + top 25 |
| 6 | Step 6 資料品質檢查 | 無 | 缺值/異常/時效 |
| 7 | 移除舊流程 | 順序 2-6 全完成 | 刪除 concept heat 選股邏輯（保留前端展示） |
