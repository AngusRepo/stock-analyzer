# Progress — StockVision

## Session 2026-05-08

### Portfolio
- Total: $1002663 (0.27%)
- Positions: 0 | Cash: $1002159
- MDD: 11.5% | Sharpe(30d): 0.3993223070363445

### Today's Pipeline
- Screener: 62 → ML BUY: 3 → T2: 2 orders
- Trades: 2 BUY / 0 SELL

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
