# P3.5 Owner Freeze

目的：把 P0-P3 重構後的 production owner 固定下來，避免多 owner、新舊並行、fallback hardcode 再次把流程弄髒。

## Authoritative Owners

| Domain | Owner | Authoritative path | 禁止再新增的平行路徑 |
| --- | --- | --- | --- |
| Cron routing | Worker cron orchestrator | `worker/src/lib/cronOrchestrator.ts`、`worker/src/lib/cronWorkerDomainTasks.ts` | route 內硬寫 cron domain knowledge |
| Pending buy lifecycle | Pending buy store/orchestrator | `worker/src/lib/pendingBuyStore.ts`、`worker/src/lib/pendingBuyOrchestrator.ts` | KV-only shadow source、route 自行推狀態 |
| Pre-trade execution gate | Paper entry task + policy | `worker/src/lib/paperEntryTasks.ts`、`worker/src/lib/preTradeExecutionPolicy.ts` | UI 判斷是否可下單、route 直接寫 gate |
| Intraday momentum data | Shioaji proxy | `shioaji-proxy/main.py` 的 `/snapshot`、`/trend`、`/market-risk` | Worker 自己猜趨勢或成交量單位 |
| Paper account value | Paper account value module | `worker/src/lib/paperAccountValue.ts` | 任何 `cash + positions` 的簡化總資產公式 |
| ML prediction runtime | ML service runtime | `ml-service/app/prediction_runtime.py` | Worker route 自行重算 ML ensemble |
| Recommendation context | Recommendation context module | `worker/src/lib/recommendationContext.ts` | Frontend 從 watch point 反推主要 domain truth |
| Bot card rendering | Frontend card component | `frontend/src/components/RecommendationCardClean.tsx` | API 汙染 UI 文案或重複解釋 |

## Freeze Rules

1. 每個 domain decision 必須只有一個 owner；router 與 UI 只負責搬運、呈現或觸發。
2. Production 只能走 V2 owner；舊 V1/V1.5 path 若暫時保留，只能是 read-only migration fallback，不得寫入 production source of truth。
3. 可 adaptive 的 runtime 參數要走 `trading:config` 或治理後的 policy source；hardcode 只能是 documented fallback default。
4. `watch_points` 只放 domain facts 與 execution events；UI 可以翻譯，不可以把翻譯再寫回 D1/KV。
5. NAV、績效、MDD、Sharpe、vs0050 必須使用 `paperAccountValue` 與 snapshot 單一路徑，不得在 route/frontend 重複計算 production truth。

## P3.5 Exit Criteria

1. Worker / Pages / ML / Shioaji proxy 的 production path 對應到 repo owner map。
2. Bot card 不再重複顯示 Alpha / Market structure / execution note。
3. Paper total asset 不因未交割買單立刻虛增；買入後用 economic NAV 顯示。
4. 年化、MDD、Sharpe、vs0050、近期報酬的 UI 顯示以 snapshot/economic value 為準。
5. Gate calibration 可以量化最近 execution gate 是否太保守，而不是靠人工猜。
