# Progress — StockVision

## Session 2026-04-09

### Portfolio
- Total: $1003849 (0.38%)
- Positions: 0 | Cash: $845899
- MDD: 10.6% | Sharpe(30d): 0.42700504402523903

### Today's Pipeline
- Screener: 23 → ML BUY: 0 → T2: 0 orders
- Trades: 0 BUY / 1 SELL

### Positions
No positions.

### Model Health
- Degraded: None
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
