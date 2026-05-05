# Progress — StockVision

## Session 2026-05-05

### Portfolio
- Total: $1002890 (0.29%)
- Positions: 0 | Cash: $959716
- MDD: 11.5% | Sharpe(30d): 0.4316746791002633

### Today's Pipeline
- Screener: 64 → ML BUY: 0 → T2: 1 orders
- Trades: 1 BUY / 0 SELL

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
