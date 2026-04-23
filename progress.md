# Progress — StockVision

## Session 2026-04-23

### Portfolio
- Total: $1001705 (0.17%)
- Positions: 0 | Cash: $1001705
- MDD: 11.5% | Sharpe(30d): 0.4708901156894861

### Today's Pipeline
- Screener: 25 → ML BUY: 0 → T2: 0 orders
- Trades: 0 BUY / 0 SELL

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
