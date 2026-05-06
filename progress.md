# Progress — StockVision

## Session 2026-05-06

### Portfolio
- Total: $1002159 (0.22%)
- Positions: 0 | Cash: $1003800
- MDD: 11.5% | Sharpe(30d): 0.40613599995262384

### Today's Pipeline
- Screener: 64 → ML BUY: 3 → T2: 0 orders
- Trades: 0 BUY / 1 SELL

### Positions
No positions.

### Model Health
- Degraded: DLinear(IC=-0.060491)
- Optuna params version: latest

### Deployments
- Worker: latest
- ML (Modal): deployed
- Controller (Cloud Run): deployed

### Cron Schedule
```
17:30 data-update → 17:40 screener → 18:00 ml-predict → 18:05 recommendation → 18:35 obsidian
07:15 morning-setup → T2 debate → paper trading
```

### Action Items
- [ ] Monitor pipeline execution
