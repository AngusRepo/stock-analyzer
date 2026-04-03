# StockVision v12

AI 驅動的台股量化分析平台 — Bottom-up 多因子選股 + RRG 產業輪動 + 10 模型 ML Ensemble + 自動紙盤交易。

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
│  Cron Pipeline:                                                  │
│    17:30 bulkFetch → 17:40 screener → Queue → 18:00 ML         │
│    → 18:05 recommendation → 18:15 verify → 18:20 adaptive      │
└────────┬───────────────────────────────────┬───────────────────┘
         │ POST /batch-predict               │ warmup / IC audit
┌────────▼──────────┐              ┌────────▼──────────┐
│  ML Controller    │              │  ML Service (ASGI)│
│  Cloud Run        │              │  Modal             │
│  FastAPI          │              │  FastAPI            │
│  Scoring/Adaptive │              │  /predict /retrain  │
└────────┬──────────┘              └───────────────────┘
         │ .map() parallel
┌────────▼──────────────────────────────────────────┐
│  Modal Functions (N parallel containers)           │
│  predict_single_stock / retrain / update_arf       │
│  10 Models: Kalman · DLinear · MarkovSwitching ·   │
│  PatchTST · Chronos · XGBoost · CatBoost ·        │
│  ExtraTrees · LightGBM · FT-Transformer           │
│  + LinUCB Bandit (Layer 1) + ARF (Layer 2)        │
│  + Conformal Prediction (Layer 3)                  │
└───────────────────────────────────────────────────┘
```

## Screener v2 — Bottom-up Multi-factor + RRG

```
Step 1: Universe（全市場 hard filter）→ ~800-1000 檔
Step 2: 多因子評分（籌碼 0-40 + 技術 0-30 + 動能 0-20 = 90）
   籌碼: 法人佔日均成交比例（相對比例，不偏向權值股）
   技術: RSI 40-80 + MACD + 均線排列 + 肯特納突破 + NATR 低波動
   動能: excess return + 量能比 + 價格意圖因子（FinLab）+ RSI 鈍化
Step 3: RRG 產業輪動（官方 38 產業，Regime-adaptive 參數）
Step 4: 情緒面（D1 news +5 + PTT buzz +5 + 概念 +5）
Step 4b: 基本面（F-Score overlay + 外資天數佔比）
Step 4c: 趨勢品質（ADX + price_intent adaptive + 流動性分級）
Step 5: 同產業 ≤5 + Pearson 60d 去重 + top 25
→ daily_recommendations（chip+tech+price）
→ ML predict → recommendation 補 ml_score → 前端顯示
```

## Data Source

| 資料 | 來源 | 穩定性 |
|------|------|--------|
| 多因子評分 | D1 stock_prices（API fallback） | 穩定（D1 有完整歷史） |
| RRG 產業輪動 | D1 stock_prices + sector_flow | 穩定 |
| 趨勢品質 + ADX | D1 stock_prices 60 天 | 穩定 |
| 報酬率去重 | D1 stock_prices 60 天 | 穩定 |
| PTT/新聞 buzz | 即時爬蟲 | 即時（假日無資料） |
| 處置股 | TWSE 即時 API | 即時 |

## Features

- **Bottom-up Screener v2** — 全市場多因子 + RRG 產業輪動 + ADX 趨勢品質 + FinLab 12 項優化
- **ML Ensemble** — 10 models + GARCH vol + HMM Regime + Conformal Prediction
- **LinUCB Bandit** — 市場情境自適應模型路由
- **ARF Aggregator** — 在線增量聚合（River ADWIN）
- **Paper Trading** — 7 層動態退出 + MDD 連續調控（FinLab 槓桿公式）
- **Debate Trader** — Claude Opus LLM 多角度辯論
- **Adaptive Engine** — 4 維自適應參數
- **IC Validation** — 因子預測力驗證（Spearman rank IC）
- **MAE Analysis** — 停損點科學化驗證
- **Risk Assessment** — VIX + TWII + 外資天數佔比 + 融資比 + ATR V 轉

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TanStack Query, Recharts, Tailwind CSS, shadcn/ui |
| API | Cloudflare Workers (Hono), D1 (SQLite), KV, Queues |
| ML Controller | Cloud Run (FastAPI), httpx + Modal SDK |
| ML Compute | Modal (Python 3.11), PyTorch, scikit-learn, XGBoost, CatBoost, LightGBM, Chronos |
| Data | TWSE/TPEx 官方 OpenAPI + D1 歷史（FinMind 已移除） |
| Notifications | Discord Webhook |

## Deployment

```bash
# Full deployment
chmod +x deploy.sh && ./deploy.sh

# ML only
cd ml-service && PYTHONIOENCODING=utf-8 python3 -m modal deploy modal_app.py

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
