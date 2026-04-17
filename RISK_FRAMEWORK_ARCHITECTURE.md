# Production Risk Framework Architecture

**Status**: Design draft — 待 user review 確認後實作
**Scope**: 從 paper trading 過渡到真實交易的完整 4-level 風控架構

---

## 📌 Current Implementation Status (2026-04-17)

**Phase**: **Not Started** — current system has only `checkCircuitBreakers()` 180-line monolith (Layer 2 portfolio-level only, early-return semantics).

| Phase | Description | Behavior change | Status |
|---|---|---|---|
| R1 Extract | Split into 7 layers + riskTypes.ts + riskChain.ts | None (keep early-return) | ❌ NOT STARTED |
| R2 Chain | Remove early-return → run all → merge (halt=OR, posPct=MIN, conf=MAX) | More conservative | ❌ NOT STARTED |
| R3 Expand | Add Level 1/3/4 + P8/P9 + audit table | New control layers | ❌ NOT STARTED |
| R4 Real | Shioaji proxy `activate_ca` + `POST /order`; Worker executeBuy/Sell call proxy | **Real order placement** | ❌ NOT STARTED |

**What exists today**:
- `checkCircuitBreakers()` in Worker, portfolio-level P1-P7 checks only
- Paper trading only — no real orders, no kill switch, no order-level gate
- Audit: `console.log` only, no D1 `risk_audit_log` table

**Prerequisites before R4 Real**:
1. OPEN ISSUE §3.1 (predict_stock_v2 crash) resolved
2. Pipeline producing >0 daily_recommendations for 3 consecutive days
3. Paper trading track record ≥ 30 days with >0.5 Sharpe
4. Wei's explicit approval — real-money switch is a Wei-only decision

Estimated effort when unblocked: **5-6 days** (R1-R4).

---

## 現況 vs 目標

| 面向 | 現在 | 目標 |
|------|------|------|
| 架構 | 單一 `checkCircuitBreakers()` 180 行 monolith | 4-level modular chain |
| Layer 合併 | 早期返回（Layer 2 遮蔽 3-7） | Chain（全部跑完取最嚴格）|
| 層級 | 只有 Level 3（Portfolio） | Level 1-4 全覆蓋 |
| 下單控制 | 無（paper trading 不需要） | Per-order gate（真實交易必須）|
| 審計 | Console log only | D1 `risk_audit_log` 完整記錄 |
| 緊急停止 | 只有 halt=true（程式觸發） | Kill switch（手動 KV flag） |

---

## 4-Level 架構總覽

```
Level 1 — System（最先，可短路）
  S1: Kill switch (KV flag)
  S2: Market data staleness
  S3: Broker proxy health
  S4: Clock skew check
  → 任一觸發 = 全停，不跑後面

Level 2 — Portfolio（全部跑，chain 合併）
  P1: MDD drawdown scale (CPPI)
  P2: Model accuracy → raise threshold
  P3: Market risk HIGH → reduce posPct
  P4: Breadth → reduce posPct
  P5: Consecutive losses → halt
  P6: Momentum zone → reduce posPct
  P7: Prediction streak → reduce posPct
  P8: Daily P&L limit (NEW)
  P9: Intraday drawdown (NEW)
  → halt=OR, posPct=MIN, conf=MAX

Level 3 — Position（買入時 per-candidate）
  N1: Sector concentration
  N2: Single-name exposure
  N3: Portfolio correlation
  → 決定能不能買「這一支」

Level 4 — Order（下單前最後一道）
  G5:  Fat finger (單筆金額上限)
  G6:  Price band (偏離收盤價 > 7%)
  G7:  Lot size (台股 1000 股整數)
  G8:  Settlement check (T+2 交割款)
  G11: Cooldown (post-exit)
  G12: Punished stock (處置股)
  G13: Limit-up lock (漲停鎖死)
  G14: Liquidity (成交量 < 5% 參與率)
  → 決定「這筆單」能不能下
```

---

## TypeScript Interfaces

### 檔案：`worker/src/lib/riskTypes.ts`

```typescript
export type RiskLevel = 'system' | 'portfolio' | 'position' | 'order'

export interface RiskCheckResult {
  layerId: string
  level: RiskLevel
  triggered: boolean
  halt: boolean
  maxPositionPct: number | null     // null = 此 layer 無意見
  buyConfThreshold: number | null
  sellConfThreshold: number | null
  reason: string
  meta: Record<string, unknown>
  evaluatedAt: string
}

export interface AggregatedRiskState {
  halt: boolean
  haltReasons: string[]
  maxPositionPct: number            // MIN across layers
  buyConfThreshold: number          // MAX across layers
  sellConfThreshold: number         // MAX across layers
  momentumZone: 'RED' | 'YELLOW' | 'GREEN'
  layers: RiskCheckResult[]
  triggeredCount: number
  severity: 'normal' | 'elevated' | 'high' | 'critical' | 'halted'
  evaluatedAt: string
}

export interface OrderValidation {
  approved: boolean
  violations: OrderViolation[]
  adjustedOrder: {
    shares: number
    limitPrice: number
    adjustmentReasons: string[]
  } | null
  checkedAt: string
}

export interface OrderViolation {
  gate: string
  severity: 'block' | 'warn' | 'adjust'
  message: string
  requestedValue: number
  allowedValue: number
}

export interface AuditEntry {
  timestamp: string
  trigger: string       // 'morning_setup' | 'intraday_buy' | 'intraday_exit' | 'kill_switch'
  accountId: number
  symbol: string | null
  side: 'buy' | 'sell' | null
  decision: string      // 'executed' | 'blocked' | 'adjusted' | 'deferred'
  riskState: AggregatedRiskState
  orderValidation: OrderValidation | null
  configVersion: string
}
```

---

## Chain Merge 語意

```typescript
// worker/src/lib/riskChain.ts

function mergeResults(defaults, results: RiskCheckResult[]): AggregatedRiskState {
  let halt = false
  const haltReasons: string[] = []
  let minPosPct = defaults.maxPositionPct
  let maxBuyConf = defaults.buyConfThreshold
  let maxSellConf = defaults.sellConfThreshold

  for (const r of results) {
    if (r.halt) {
      halt = true
      haltReasons.push(`[${r.layerId}] ${r.reason}`)
    }
    if (r.maxPositionPct !== null)
      minPosPct = Math.min(minPosPct, r.maxPositionPct)   // 最嚴格
    if (r.buyConfThreshold !== null)
      maxBuyConf = Math.max(maxBuyConf, r.buyConfThreshold) // 最高門檻
    if (r.sellConfThreshold !== null)
      maxSellConf = Math.max(maxSellConf, r.sellConfThreshold)
  }

  return {
    halt,
    haltReasons,
    maxPositionPct: halt ? 0 : minPosPct,
    buyConfThreshold: maxBuyConf,
    sellConfThreshold: maxSellConf,
    // ... severity, triggeredCount, etc.
  }
}
```

**為什麼用 MIN 不用乘法**：
- 乘法：L3(×0.5) × L6(×0.3) × L7(×0.3) = ×0.045 → 8% × 0.045 = 0.36% ≈ halt
- MIN：min(4%, 2.4%, 2.4%) = 2.4% → 保留最嚴格 layer 的獨立判斷

---

## RiskConfig（新 KV key `trading:risk_config`）

與 `trading:config` 分開存放 — Kill switch 必須能在 1 秒內更新，不能跟 200+ 策略參數共用同一個 KV key。

```typescript
export interface RiskConfig {
  system: {
    killSwitch: boolean                    // 緊急停止（手動）
    quoteStalenessTolerance: number        // 秒，default 120
    dailyDataStalenessTolerance: number    // 秒，default 86400
    haltOnProxyFailure: boolean            // default true (real trading)
  }
  portfolio: {
    dailyPnlLossLimit: number              // NT$，default -30000
    dailyPnlLossLimitPct: number           // default -0.03
    intradayDrawdownHalt: number           // default 0.05
  }
  position: {
    maxPerSector: number                   // default 2
    maxSingleNamePct: number              // default 0.25
    correlationThreshold: number           // default 0.7
    correlationWindow: number              // trading days, default 60
  }
  order: {
    maxSingleOrderValue: number            // NT$，default 300000
    maxPriceDeviationPct: number           // default 0.07 (台股漲跌幅 10%)
    maxDailyBuyOrders: number              // default 5
    maxDailySellOrders: number             // default 10
    enforceRegularLots: boolean            // default true (1000 股整手)
    maxVolumeParticipation: number         // default 0.05 (5% 日均量)
  }
}
```

---

## Audit Trail D1 Schema

```sql
-- migration_risk_audit.sql

CREATE TABLE IF NOT EXISTS risk_audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_event    TEXT NOT NULL,
  account_id       INTEGER NOT NULL DEFAULT 1,
  symbol           TEXT,
  side             TEXT,
  decision         TEXT NOT NULL,
  halt             INTEGER NOT NULL DEFAULT 0,
  triggered_count  INTEGER NOT NULL DEFAULT 0,
  severity         TEXT NOT NULL DEFAULT 'normal',
  max_position_pct REAL,
  buy_conf_threshold REAL,
  risk_state_json  TEXT NOT NULL,
  order_validation_json TEXT,
  config_version   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_risk_audit_ts   ON risk_audit_log(timestamp DESC);
CREATE INDEX idx_risk_audit_halt ON risk_audit_log(halt, timestamp DESC);
CREATE INDEX idx_risk_audit_sev  ON risk_audit_log(severity, timestamp DESC);
```

Retention: 90 天 hot（D1），週 cron `DELETE WHERE timestamp < datetime('now', '-90 days')`

---

## 檔案結構

```
worker/src/lib/
  riskTypes.ts              ← interfaces
  riskConfig.ts             ← RiskConfig defaults + KV read/write + validation
  riskChain.ts              ← mergeResults() + runSystemChecks() + runPortfolioChecks()
  validateOrder.ts          ← Level 4 per-order gates
  riskAudit.ts              ← writeAuditEntry() + pruneOldEntries()
  riskChecks/
    s1KillSwitch.ts         ← Level 1
    s2DataStaleness.ts      ← Level 1
    s3ProxyHealth.ts        ← Level 1
    p1Mdd.ts                ← Level 2 (existing Layer 1)
    p2Accuracy.ts           ← Level 2 (existing Layer 2)
    p3MarketRisk.ts         ← Level 2 (existing Layer 3)
    p4Breadth.ts            ← Level 2 (existing Layer 4)
    p5Losses.ts             ← Level 2 (existing Layer 5)
    p6Momentum.ts           ← Level 2 (existing Layer 6)
    p7Streak.ts             ← Level 2 (existing Layer 7)
    p8DailyPnl.ts           ← Level 2 NEW
    p9IntradayDd.ts         ← Level 2 NEW
    n1SectorConc.ts         ← Level 3
    n2SingleName.ts         ← Level 3
    n3Correlation.ts        ← Level 3
worker/
  migration_risk_audit.sql
```

每個 check 檔案 export 一個 async function：
```typescript
export async function checkP1Mdd(db, cfg, defaults): Promise<RiskCheckResult>
```

→ 獨立可測、獨立可 feature-flag、明確依賴。

---

## 整合到現有流程

```
Morning Setup (09:00)
  ├─ Level 1: runSystemChecks(env) → halt? → 全停
  ├─ Level 2: runPortfolioChecks(db, cfg, kv) → AggregatedRiskState
  │   └─ cache 到 KV paper:risk_state:<today>（intraday 用）
  ├─ filter candidates (debate, quadrant, cooldown)
  ├─ Level 3: per candidate runPositionChecks(candidate, riskState, holdings)
  └─ write pending_buys (only passing candidates)

Intraday Check (每分鐘)
  ├─ exit check → for each exit: validateOrder(sell)
  ├─ refresh AggregatedRiskState (每 5 分鐘重跑 Level 2)
  ├─ for each pending buy:
  │   ├─ price <= entry?
  │   ├─ Level 4: validateOrder(buy) → OrderValidation
  │   └─ approved → execute + audit | blocked → audit + keep/remove
  └─ write audit entries

Real Trading (future)
  └─ validateOrder → executeBrokerOrder (Shioaji proxy)
      ├─ 最後一道 kill switch check（直接讀 KV，不走 cache）
      ├─ POST /order to proxy
      └─ confirm fill → audit
```

---

## 4-Phase 實作計畫

| Phase | 內容 | 行為改變 | Rollback | 工作量 |
|-------|------|---------|---------|--------|
| **1. Extract** | 拆 7 layer 到獨立檔案 + riskTypes + riskChain | **零改變**（保持早期返回） | KV flag `risk:use_chain=v1` | 1 天 |
| **2. Chain** | 移除早期返回，全跑 + merge | **更保守**（多 layer 可同時觸發） | KV flag `risk:use_chain=v0` 回舊版 | 1 天 |
| **3. Expand** | 加 Level 1/3/4 + P8/P9 + audit table | 新增控制層 | 各 layer 獨立 feature flag | 2-3 天 |
| **4. Real** | Proxy 加 `activate_ca` + `POST /order`；Worker 改 call proxy | 真實下單 | `riskConfig.system.killSwitch=true` | 1 天 |

**總計 ~5-6 天可完成 paper → real 過渡。**

### Phase 4 說明

Shioaji proxy **已經 deploy 在 Cloud Run**，目前開放查價權限（`GET /quote`），paper trading 用的是**真實市價**。過渡到真實交易只需要：

1. Shioaji proxy 加 `activate_ca`（電子憑證啟用）+ 新增 `POST /order` endpoint
2. Worker 的 `executeBuy` / `executeSell` 從「寫 D1 `paper_orders`」改成「call proxy `/order`」
3. `validateOrder()` 的全部 Level 4 gate 接在 call 之前

**不需要重新整合 broker API** — broker 已接好，差的只是開啟下單功能 + 一個 endpoint。

---

## 與業界標準對照

| FIA 2024 標準 | 我們的對應 | 狀態 |
|--------------|----------|------|
| Pre-trade order validation | Level 4 validateOrder | Phase 3 新增 |
| Real-time position monitoring | Level 2 P1/P8/P9 | P1 有，P8/P9 Phase 3 |
| Kill switch | Level 1 S1 | Phase 3 新增 |
| Market data quality | Level 1 S2（Shioaji proxy 已提供 real-time quotes）| Phase 3 新增 staleness check |
| Post-trade audit | risk_audit_log | Phase 3 新增 |
| Exchange circuit breakers | N/A（台交所自己有） | 不需要 |

| 我們獨有（ML-specific） | 業界沒有 |
|------------------------|---------|
| P2 Model accuracy threshold | ML 系統才需要 |
| P6 Momentum crash zone | 學術導向 |
| P7 Prediction streak | ML 即時品質監控 |
| Post-exit cooldown | 行為金融紀律 |
| Persona-driven sizing | 台股參與者結構 |
