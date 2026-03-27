# StockVision v12 程式碼審查報告

**審查日期：** 2026-03-21
**審查範圍：** StockVision v12 Cloudflare Worker 後端程式碼
**審查人員：** Claude Code (claude-sonnet-4-6)
**報告語言：** 繁體中文（程式碼片段保留英文）

---

## 執行摘要

本次審查針對 StockVision v12 專案的 Cloudflare Worker 後端程式碼進行全面性檢視，共發現 **14 項問題**，分類如下：

| 嚴重程度 | 數量 | 說明 |
|----------|------|------|
| 嚴重 Bug | 4 | 資料完全錯誤或靜默失敗，影響核心功能 |
| 中等 Bug | 5 | 邏輯錯誤或邊界情況，會導致部分功能異常 |
| 程式碼品質優化 | 5 | 死碼、計算誤差、寫入效率等改進建議 |

**最高優先級修復項目：**
1. `predictionVerifier.ts:348` — SQL 欄位名稱拼寫錯誤，導致準確率欄位永遠不會被更新
2. `predictionVerifier.ts:284,288` — 風險等級值不匹配，導致所有風險相關準確率統計永遠為 NULL
3. `llm.ts:163` — Copy-paste 錯誤，EPS 欄位錯誤顯示 PE 值

建議在下一個 Release 前完成所有「嚴重 Bug」的修復，「中等 Bug」納入下一個 Sprint 排程。

---

## 嚴重 Bug

### Bug 1 — SQL 欄位名稱拼寫錯誤（靜默失敗）

**檔案：** `worker/src/predictionVerifier.ts`
**行號：** 348
**影響：** `accuracy_in_high_risk` 欄位永遠不會被寫入，所有高風險情境的準確率統計遺失

**問題描述：**
UPDATE 語句中欄位名稱拼寫錯誤為 `accuracy_in_high_isk`（少了字母 `r`），由於 SQL 在部分資料庫中對欄位拼寫錯誤會靜默失敗而非拋出例外，此錯誤不會在執行期觸發任何警告，導致資料長期錯誤而不自知。

**錯誤程式碼：**
```typescript
// predictionVerifier.ts:348 — 拼寫錯誤
`accuracy_in_high_isk = ?`
//                ^ 缺少 'r'，應為 accuracy_in_high_risk
```

**修正方式：**
```typescript
// 修正後
`accuracy_in_high_risk = ?`
```

**風險評估：** 此 Bug 導致所有高風險情境的模型準確率統計完全遺失，長期累積會使準確率分析報表呈現嚴重偏差。

---

### Bug 2 — 市場風險等級值不匹配（查詢永遠回傳 0 筆）

**檔案：** `worker/src/predictionVerifier.ts`
**行號：** 284、288
**影響：** `accuracy_in_low_risk` 與 `accuracy_in_high_risk` 永遠為 NULL

**問題描述：**
`predictionVerifier.ts` 中用來分類低風險與高風險的 SQL 篩選條件，使用了 `'low'`、`'high'`、`'extreme'` 等字串；然而 `marketRisk.ts` 實際儲存至資料庫的風險等級值為顏色代碼（`'green'`、`'yellow'`、`'orange'`、`'red'`、`'black'`）。兩邊值域完全不重疊，導致 `lowRisk` 與 `highRisk` 的子查詢永遠回傳 0 筆資料，計算出的準確率因此永遠為 NULL。

**錯誤程式碼：**
```typescript
// predictionVerifier.ts:284 — 低風險篩選
WHERE market_risk IN ('low')                    // ❌ 實際值為 'green','yellow'

// predictionVerifier.ts:288 — 高風險篩選
WHERE market_risk IN ('high', 'extreme')        // ❌ 實際值為 'red','black'
```

**正確的值域對應關係（來自 marketRisk.ts）：**

| 語意等級 | 實際儲存值 |
|----------|-----------|
| 低風險（low） | `'green'`, `'yellow'` |
| 中風險（medium） | `'orange'` |
| 高風險（high） | `'red'`, `'black'` |

**修正方式：**
```typescript
// 修正後 — 低風險篩選
WHERE market_risk IN ('green', 'yellow')

// 修正後 — 高風險篩選
WHERE market_risk IN ('red', 'black')
```

**注意：** 此 Bug 與 Bug 1 同時存在，即使修正了欄位名稱拼寫，若不同時修正此處的值域對應，仍然無法正確計算高風險準確率。

---

### Bug 3 — Null URL 去重導致多筆新聞資料被丟棄

**檔案：** `worker/src/news.ts`
**行號：** 183
**影響：** 當 URL 無效（`safeUrl = null`）時，多筆新聞項目中只有第一筆會被保留，其餘全部被 Set 去重機制誤刪

**問題描述：**
去重邏輯使用 `Set` 記錄已出現的 URL，當 `safeUrl` 為 `null` 時，所有 null 值會被視為「同一個 URL」，導致第二筆之後具有無效 URL 的新聞全部被丟棄。對於來源不提供標準 URL 的新聞（或 URL 解析失敗的情境），這會造成大量資料遺失。

**錯誤程式碼：**
```typescript
// news.ts:183 — null 被誤視為已出現的重複 URL
const seenUrls = new Set<string | null>();
if (seenUrls.has(safeUrl)) continue;  // null === null，第二筆起全被跳過
seenUrls.add(safeUrl);
```

**修正方式：**
```typescript
// 修正後 — null URL 不參與去重邏輯
const seenUrls = new Set<string>();
if (safeUrl !== null && seenUrls.has(safeUrl)) continue;
if (safeUrl !== null) seenUrls.add(safeUrl);
```

---

### Bug 4 — Copy-paste 錯誤：EPS 欄位錯誤顯示 PE 值

**檔案：** `worker/src/llm.ts`
**行號：** 163
**影響：** 聊天機器人提供給使用者的 EPS 數據完全錯誤，顯示的是 PE 值

**問題描述：**
在組裝 LLM 的上下文字串時，EPS 與 PE 兩個欄位皆從 `financials.pe` 取值，這是典型的 Copy-paste 錯誤。聊天機器人因此永遠回答相同的 EPS 與 PE 數字，且 EPS 值實際上是錯誤的 PE 數值。

**錯誤程式碼：**
```typescript
// llm.ts:163 — EPS 欄位錯誤使用 financials.pe
context += `\nEPS: ${financials.pe ?? 'N/A'} | PE: ${financials.pe ?? 'N/A'}`
//                          ^^^^ 應為 financials.eps
```

**修正方式：**
```typescript
// 修正後
context += `\nEPS: ${financials.eps ?? 'N/A'} | PE: ${financials.pe ?? 'N/A'}`
```

---

## 中等 Bug

### Bug 5 — NEGATIVE_KEYWORDS 陣列中「虧損」重複出現

**檔案：** `worker/src/news.ts`
**行號：** 16
**影響：** 低；重複關鍵字不影響功能正確性，但增加不必要的比對次數

**問題描述：**
`NEGATIVE_KEYWORDS` 常數陣列中，`'虧損'` 這個關鍵字被定義了兩次。雖然功能上不會造成錯誤（重複的字串不改變 `includes()` 的判斷結果），但屬於程式碼品質問題，會增加每次關鍵字掃描的無效迭代。

**錯誤程式碼：**
```typescript
// news.ts:16 — '虧損' 出現兩次
const NEGATIVE_KEYWORDS = [
  '虧損', '下跌', '衰退', '虧損', '倒閉', ...  // ❌ 重複
];
```

**修正方式：**
```typescript
// 修正後 — 移除重複項目
const NEGATIVE_KEYWORDS = [
  '虧損', '下跌', '衰退', '倒閉', ...
];
```

---

### Bug 6 — 函式文件與實際行為不符（使用模型與快取機制）

**檔案：** `worker/src/llm.ts`
**行號：** 38、116、142
**影響：** 中；誤導開發者對效能表現的預期，實際使用較低品質的模型

**問題描述：**
`generateAnalystSummary` 函式的行內說明（第 116 行）寫道「使用 Sonnet + Prompt Cache」，但實際呼叫（第 142 行）使用 `callClaude(apiKey, system, prompt, 1500)` 而未傳入 model 參數，因此使用預設模型（haiku），且未啟用 Prompt Cache。這會造成以下問題：
1. 開發者看文件以為用的是高品質 Sonnet 模型，實際上是 haiku
2. 未啟用快取，高頻呼叫時成本偏高

**問題程式碼：**
```typescript
// llm.ts:116 — 文件聲稱使用 Sonnet + Prompt Cache
// 使用 Sonnet + Prompt Cache

// llm.ts:142 — 實際呼叫未指定模型、未啟用快取
const result = await callClaude(apiKey, system, prompt, 1500);
//                                                          ^ 缺少 model 與 cache 參數
```

**修正方式：**
```typescript
// 選項一：更新文件以符合實際行為
// 使用預設模型（haiku），無快取

// 選項二：更新程式碼以符合文件說明
const result = await callClaude(apiKey, system, prompt, 1500, 'claude-sonnet-4-5', true);
```

---

### Bug 7 — Cron 排程器使用 `else` 作為 fallback 存在潛在誤觸發

**檔案：** `worker/src/index.ts`
**行號：** 583–585
**影響：** 中；未來新增 Cron 時可能意外觸發 `runDailyUpdate`

**問題描述：**
Cron 排程分派器以 `else` fallback 的方式呼叫 `runDailyUpdate()`，而非明確比對 `'5 7 * * 1-5'` 這個 Cron 表達式。當未來開發者新增其他 Cron 工作而忘記在 `else` 之前加入對應的 `else if`，新的 Cron 觸發時將會意外執行每日更新流程。

**錯誤程式碼：**
```typescript
// index.ts:583-585 — 使用 else 作為 fallback
} else {
  await runDailyUpdate(env);  // ❌ 任何未匹配的 Cron 都會觸發此函式
}
```

**修正方式：**
```typescript
// 修正後 — 使用明確的 Cron 表達式比對
} else if (cron === '5 7 * * 1-5') {
  await runDailyUpdate(env);
} else {
  console.warn(`Unknown cron trigger: ${cron}`);
}
```

---

### Bug 8 — simulateTrade 中目標一達成後仍可被停損覆蓋

**檔案：** `worker/src/predictionVerifier.ts`
**行數：** `simulateTrade` 函式內
**影響：** 高；交易模擬結果錯誤，目標一達成的交易可能被誤判為停損出場

**問題描述：**
當價格觸及 `target1` 後，程式碼將 `outcome` 設為 `'hit_target1'`、`exitPrice` 設為 `target1`，但迴圈並未結束。後續 K 棒的停損檢查仍然執行，若後續 K 棒低於停損價，`outcome` 會被覆蓋為 `'hit_stop'`，錯誤地將一筆已獲利的交易記錄為虧損出場。

**錯誤程式碼：**
```typescript
// simulateTrade — 缺少已達目標一的狀態追蹤
if (bar.low <= stopLoss) {
  outcome = 'hit_stop';       // ❌ 即使已達 target1 仍可能被覆蓋
  exitPrice = stopLoss;
  break;
}
if (bar.high >= target1) {
  outcome = 'hit_target1';
  exitPrice = target1;
  // 迴圈未 break，後續停損檢查仍在執行
}
```

**修正方式：**
```typescript
// 修正後 — 加入 alreadyHitTarget1 旗標
let alreadyHitTarget1 = false;

for (const bar of bars) {
  if (!alreadyHitTarget1 && bar.low <= stopLoss) {
    outcome = 'hit_stop';
    exitPrice = stopLoss;
    break;
  }
  if (!alreadyHitTarget1 && bar.high >= target1) {
    outcome = 'hit_target1';
    exitPrice = target1;
    alreadyHitTarget1 = true;
    // 繼續追蹤是否達到 target2，或依業務邏輯決定是否 break
  }
}
```

---

### Bug 9 — marginRows 宣告後從未使用

**檔案：** `worker/src/marketRisk.ts`
**行號：** 118
**影響：** 中；程式碼邏輯與意圖不符，最終使用的是未篩選的原始陣列

**問題描述：**
程式碼宣告了 `marginRows` 變數並對 `rows` 進行篩選，但後續計算時仍讀取 `rows[rows.length - 1]`（未篩選的原始陣列）而非 `marginRows`。這導致篩選邏輯完全無效，最終使用的是錯誤的資料集。

**錯誤程式碼：**
```typescript
// marketRisk.ts:118 — marginRows 宣告但從未被讀取
const marginRows = rows.filter(r => r.margin !== null);  // 宣告但未使用
// ...
const latestRow = rows[rows.length - 1];  // ❌ 應為 marginRows[marginRows.length - 1]
```

**修正方式：**
```typescript
// 修正後
const marginRows = rows.filter(r => r.margin !== null);
const latestRow = marginRows[marginRows.length - 1];
// 注意：需同時處理 marginRows 為空陣列的邊界情況
if (!latestRow) return null;
```

---

## 程式碼品質優化

### 優化 1 — 死碼：predRows 查詢結果從未使用

**檔案：** `worker/src/dailyRecommendation.ts`
**行號：** 163–176
**影響：** 低；增加不必要的 D1 查詢，浪費資源

**問題描述：**
`predRows` 的 SQL 查詢被執行，但查詢結果從未被後續程式碼使用。第 179 行的註解說明「用簡單查詢替代」，顯示此段落是重構過程中遺留的死碼，應完整移除。

**建議操作：** 移除 163–176 行的 `predRows` 查詢及相關宣告，保留第 179 行之後的替代邏輯。

---

### 優化 2 — avg_rsi 滾動平均計算公式錯誤

**檔案：** `worker/src/dailyRecommendation.ts`
**行號：** 110
**影響：** 中；當資料點超過 2 筆時，avg_rsi 計算結果系統性偏低

**問題描述：**
目前使用簡單的兩點平均 `(prev + new) / 2`，但當已累積多筆資料時，這個公式並非正確的累積平均，會導致越到後面的計算越不準確（實際上是加權偏向最新兩筆值）。

**錯誤程式碼：**
```typescript
// dailyRecommendation.ts:110 — 錯誤的滾動平均公式
s.avg_rsi = s.avg_rsi == null ? r.rsi14 : (s.avg_rsi + r.rsi14) / 2
//                                         ^^^^^^^^^^^^^^^^^^^^^^^^
//                                         僅考慮前一個平均值與新值，忽略 N
```

**修正方式：**
```typescript
// 修正後 — 使用正確的累積平均公式
s.count = (s.count ?? 0) + 1;
s.avg_rsi = s.avg_rsi == null
  ? r.rsi14
  : (s.avg_rsi * (s.count - 1) + r.rsi14) / s.count;
```

---

### 優化 3 — 使用 INSERT OR IGNORE + UPDATE 雙寫模式

**檔案：** `worker/src/predictionVerifier.ts`
**行號：** 494–503
**影響：** 低；造成不必要的 D1 寫入操作，增加費用與延遲

**問題描述：**
目前的 Upsert 邏輯分兩步驟：先 `INSERT OR IGNORE`（若不存在則新增），再執行 `UPDATE`（更新資料）。這會在資料已存在時產生兩次 D1 寫入。應使用標準的 `INSERT ... ON CONFLICT DO UPDATE` 語法（SQLite UPSERT）一次完成操作。

**錯誤程式碼：**
```typescript
// predictionVerifier.ts:494-503 — 雙寫模式
await db.prepare(`INSERT OR IGNORE INTO ... VALUES (?)`).bind(...).run();
await db.prepare(`UPDATE ... SET col = ? WHERE id = ?`).bind(...).run();
```

**修正方式：**
```sql
-- 修正後 — 使用 SQLite UPSERT 語法
INSERT INTO table_name (id, col)
VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET
  col = excluded.col;
```

---

### 優化 4 — 「連買天數」標籤語意誤導

**檔案：** `worker/src/dailyRecommendation.ts`
**行號：** 136–146
**影響：** 低；使用者介面顯示的指標語意與實際計算邏輯不符

**問題描述：**
「連買天數」這個標籤讓使用者預期看到的是「最近連續買入的天數」（例如：最近 3 天連續買入），但 SQL 實際計算的是過去 10 天中，買入次數與賣出次數的淨差值（+1 加總）。兩者在語意上有明顯差異，使用者可能誤解指標含義。

**建議操作：**
- 若保持現有 SQL 計算邏輯，將標籤改為「近 10 日淨買超天數」
- 若需要真正的「連買天數」，需修改 SQL 為從最近一天往前計算連續買入的天數

---

### 優化 5 — processUpdateBatch 序列處理與限速說明不足

**檔案：** `worker/src/index.ts`
**行號：** 130–138
**影響：** 低；程式碼意圖不明，維護者難以理解 300ms 延遲的必要性

**問題描述：**
`processUpdateBatch` 以序列方式處理每支股票，每筆之間加入 300ms 的 sleep。這個設計是為了避免觸發 FinMind API 的速率限制，屬於合理設計，但現有的程式碼註解未清楚說明此原因，未來維護者可能誤認為是多餘的延遲而將其移除，導致 API 被封鎖。

**建議操作：**
```typescript
// 修正後 — 加入明確的限速說明
// FinMind API 限制每分鐘請求數，序列處理並間隔 300ms 以避免觸發 rate limit
// 請勿改為並行處理，否則會導致 429 Too Many Requests 錯誤
await sleep(300);
```

---

## 問題彙整表

| # | 檔案 | 行號 | 嚴重程度 | 問題摘要 | 狀態 |
|---|------|------|----------|----------|------|
| 1 | `predictionVerifier.ts` | 348 | 嚴重 | SQL 欄位名稱拼寫錯誤 `accuracy_in_high_isk` | 待修復 |
| 2 | `predictionVerifier.ts` | 284, 288 | 嚴重 | 市場風險等級值不匹配，查詢永遠回傳 0 筆 | 待修復 |
| 3 | `news.ts` | 183 | 嚴重 | Null URL 去重導致多筆新聞被丟棄 | 待修復 |
| 4 | `llm.ts` | 163 | 嚴重 | Copy-paste 錯誤，EPS 顯示 PE 值 | 待修復 |
| 5 | `news.ts` | 16 | 中等 | `'虧損'` 關鍵字重複定義 | 待修復 |
| 6 | `llm.ts` | 38, 116, 142 | 中等 | 文件聲稱 Sonnet + Cache，實際用 haiku 且無快取 | 待修復 |
| 7 | `index.ts` | 583–585 | 中等 | Cron 分派器使用 `else` fallback，潛在誤觸發 | 待修復 |
| 8 | `predictionVerifier.ts` | simulateTrade | 中等 | 達到目標一後仍可被停損結果覆蓋 | 待修復 |
| 9 | `marketRisk.ts` | 118 | 中等 | `marginRows` 宣告後從未使用，讀取原始陣列 | 待修復 |
| 10 | `dailyRecommendation.ts` | 163–176 | 優化 | 死碼：`predRows` 查詢結果從未使用 | 待修復 |
| 11 | `dailyRecommendation.ts` | 110 | 優化 | `avg_rsi` 滾動平均計算公式錯誤 | 待修復 |
| 12 | `predictionVerifier.ts` | 494–503 | 優化 | 雙寫模式應改為 `INSERT ... ON CONFLICT DO UPDATE` | 待修復 |
| 13 | `dailyRecommendation.ts` | 136–146 | 優化 | 「連買天數」標籤語意與實際 SQL 邏輯不符 | 待修復 |
| 14 | `index.ts` | 130–138 | 優化 | 300ms 限速延遲缺乏說明，維護風險高 | 待修復 |

---

*本報告由 Claude Code 自動生成，建議由人工審查確認後再進行修復。*
