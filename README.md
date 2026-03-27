# StockVision v12

AI 驅動的台股分析平台 — 10 模型 ML Ensemble + 自動紙盤交易 + 全市場選股。

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (Cloudflare Pages)                                     │
│  React + Vite + TanStack Query + Recharts + Tailwind + shadcn   │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
┌────────────────────────▼────────────────────────────────────────┐
│  Worker (Cloudflare Workers)                                     │
│  Hono API + D1 + KV + Queues                                    │
│  Cron: 15 排程（大盤/更新/ML/推薦/驗證/紙盤/報告）               │
└────────┬───────────────────────────────┬───────────────────────┘
         │ POST /batch-predict           │ warmup / IC audit
┌────────▼──────────┐          ┌────────▼──────────┐
│  ML Controller    │          │  ML Service (ASGI)│
│  Cloud Run        │          │  Modal             │
│  FastAPI          │          │  FastAPI            │
│  Scoring/Adaptive │          │  /predict /retrain  │
└────────┬──────────┘          └───────────────────┘
         │ .map() parallel
┌────────▼──────────────────────────────────────────┐
│  Modal Functions (N parallel containers)           │
│  predict_single_stock / retrain / update_arf       │
│  10 Models: Kalman · DLinear · MarkovSwitching ·   │
│  PatchTST · Chronos · XGBoost · CatBoost ·        │
│  ExtraTrees · LightGBM · FT-Transformer           │
│  + LinUCB Bandit (Layer 1) + ARF (Layer 2)        │
└───────────────────────────────────────────────────┘
```

## Features

- **ML Ensemble** — 10 models (5 price + 5 feature) + GARCH vol + HMM Regime + Stacking Meta-learner
- **LinUCB Bandit** — 第 11 模型 Layer 1：市場情境自適應路由
- **ARF Aggregator** — 第 11 模型 Layer 2：在線增量聚合（River ADWIN）
- **Market Screener** — 全市場自動選股 + 族群輪動偵測 + 歷史勝率加權
- **Paper Trading** — 7 層動態退出（硬止損/ATR/Chandelier/TP1分批/TP2/ML SELL/時間止損）
- **Debate Trader** — Claude Opus LLM 多角度辯論 → 決定倉位升降級
- **Adaptive Engine** — 4 維自適應參數（信心門檻/PF品質/SL_TP Regime/Bandit保護）
- **Risk Assessment** — VIX + TWII + 外資連賣 + 融資比 + 跌停家數 → 五級風險
- **US Leading Indicators** — SOX/S&P500/DXY/HY Spread/VIX → 台股先行判斷
- **Dashboard** — Dark mode, Mobile-first, K 線圖 + 6 條均線 + 籌碼 + AI 分析

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TanStack Query, Recharts, Tailwind CSS, shadcn/ui |
| API | Cloudflare Workers (Hono), D1 (SQLite), KV, Queues |
| ML Controller | Cloud Run (FastAPI), httpx + Modal SDK |
| ML Compute | Modal (Python 3.11), PyTorch, scikit-learn, XGBoost, CatBoost, LightGBM, Chronos |
| Data | FinMind API (TWSE/OTC), Yahoo Finance (US), Shioaji (real-time) |
| Notifications | Discord Webhook |
| Backtesting | Freqtrade (Docker) |

## Deployment

```bash
# Full deployment (first time)
chmod +x deploy.sh && ./deploy.sh

# ML only update
cd ml-service && python3 -m modal deploy modal_app.py

# Worker only
cd worker && npx wrangler deploy

# Frontend only
cd frontend && npm run build && npx wrangler pages deploy dist --project-name=stockvision-frontend
```

## Cost

| Service | Monthly |
|---|---|
| Cloudflare Workers/Pages/D1/KV | Free tier |
| Cloud Run (Controller) | ~$0.05 |
| Modal (ML Compute) | ~$17 ($30 free credit covers) |
| **Total** | **~$0** |

## Version History

See [CHANGELOG.md](./CHANGELOG.md) for detailed version history.
