# FinLab Factor / Strategy Map for StockVision V4

## Scope

This file maps FinLab API fields, Skill/research usage, and full-site article-derived ideas into StockVision adoption buckets.

Sources:

```text
FINLAB_DATA_CATALOG.md
FINLAB_ADOPTION_PLAN.md
FINLAB_DAGSTER_ASSETS.md
FINLAB_RESEARCH_DIGEST.md
data/finlab_research/api_fields.json
data/finlab_research/adoption_plan.json
data/finlab_research/dagster_asset_graph.json
data/finlab_research/article_notes.json
```

Storage rule: keep only transformed research notes and implementation guidance. Do not store FinLab article bodies.

## Adoption Principle

FinLab fields are split into two production-planning lanes:

```text
parity lane:
  fields that replace or verify the current TWSE/TPEX/StockVision equivalent

diversity lane:
  FinLab-native fields that add coverage, factor breadth, taxonomy depth, or
  market context even when StockVision has no current field
```

The 106-feature contract remains the stable downstream interface. New FinLab
fields should first land in a feature lake sidecar with source, freshness,
schema, and promotion-gate metadata.

## P0: Direct Adoption

| Family | FinLab data / article source | StockVision implementation | Gate |
|---|---|---|---|
| Security master | `security_categories` | Primary market lane, name, industry, symbol universe. | 7820=OTC, 6682=EMERGING. |
| Taxonomy expansion | `security_categories`, `security_industry_themes` | `industry`, `industry_theme`, `subindustry` tags; keep StockVision concept tags as market-topic overlays. | No raw all-theme dump into concept tags; no double-counting in sector flow. |
| Daily OHLCV | `price:*`, `etl:*` | Replace TWSE/TPEX daily price ingestion after parity run. | 20-30 trading-day parity. |
| Monthly revenue | `monthly_revenue:*` | Revenue momentum and revenue-price double momentum. | Announcement-date alignment. |
| Fundamentals | `financial_statement:*`, `fundamental_features:*` | Quality, value, growth, profitability, leverage, cash-flow factors. | No look-ahead; report-date availability. |
| Institutional flow | `institutional_investors_trading_summary:*` | Foreign/trust/dealer flow, alignment, theme flow. | Price-location and liquidity gates. |
| Margin / lending | `margin_transactions:*`, `security_lending:*` | Margin heat, short pressure, unwind risk. | Extreme-value winsorization. |
| Broker flow diversity | `broker_transactions`, `etl:broker_transactions:*`, `rotc_broker_transactions` | Broker concentration, branch-flow anomaly, emerging-stock chip proxy. | Listed stocks shadow first; emerging stocks are watchlist-only. |
| Emerging-stock diversity | `rotc_price:*`, `rotc_monthly_revenue:*`, `rotc_broker_transactions` | Emerging watchlist, liquidity/spread risk, revenue progress, broker concentration. | Never marks eligible for pending buy. |
| World index | `world_index:*` | Morning setup and regime context. | Delay/coverage check. |
| Backtest reality | FinLab liquidity / MAE-MFE / tradability articles | Add capacity, cost, slippage, limit-lock, disposition, full-delivery, turnover, MAE/MFE. | StockVision backtest remains production truth. |
| FinLab benchmark | FinLab backtest output | External sanity check against StockVision backtest metrics. | `allowed_use=sanity_check_only`; no recommendation, rank, paper-fill, pending-buy, or promotion effect. |
| Paper-trade preview | FinLab order/execution articles and SDK docs | `FINLAB_PAPER_TRADE_INTEGRATION.md` and Worker preview contract normalize FinLab pass/blocked/warning/error into audit-only `finlab_preview` events. | No `paper_orders`, `paper_positions`, `paper_settlements`, pending buys, fills, or `execution_status=filled` from FinLab preview. |
| Execution preview | FinLab order/execution articles and SDK docs | `FINLAB_EXECUTION_ADAPTER.md` and `finlab_execution_adapter.py` parse pass/blocked/warning/error into preview evidence for future handoff review. | `can_submit_real_order=false`; live submit and order-id payloads are rejected/quarantined until a separately approved execution path exists. |
| Dashboard visibility | FinLab diff and preview events | `DASHBOARD_V4_CONTRACT.md` exposes FinLab parity/diversity diff and preview blocked reasons as audit panels. | FinLab does not own price candles, model signals, regime, sector flow, data quality, paper fills, or order submit state. |

## P1: Shadow Test

| Family | Candidate factors | StockVision path | Risk |
|---|---|---|---|
| Revenue growth | monthly revenue YoY/MoM, cumulative revenue, revenue acceleration | Shadow feature, then screener challenger. | Publication timing and restatement drift. |
| Quality | F-Score, ROE, DuPont, cash flow, operating margin, off-operating-income ratio | Shadow feature family against 106-feature baseline. | Sector comparability. |
| Value / growth | PE, PB, PEG, market-cap-to-sales, industry-relative valuation | Shadow valuation rank. | Cheap traps and sector regime sensitivity. |
| R&D / contract liabilities | R&D expense ratio, contract liabilities for construction/real-estate sectors | Sector-specific challenger. | Narrow universe and accounting comparability. |
| Low volatility | NATR, standard deviation, Keltner/ATR variants | Shadow risk-adjusted entry feature. | May underperform in momentum regimes. |
| Momentum / breadth | acceleration, AROON, ADL, new-high breadth, moving-average defense | Regime and screener shadow. | Over-sensitive exits. |
| Breakout quality | false-breakout filters, KD/RSI dulling, volume/volatility confirmation | Shadow screener filter. | Late entries and overfitting. |
| Chip alignment | foreign hedge, trust-following, three-party alignment, broker concentration | Sector flow V4 and candidate score shadow. | Chasing crowded trades. |
| Event studies | buyback, capital reduction, cash issuance short, disposition stocks, investor conference, credit-trading restoration | Event module shadow. | Sparse event samples. |
| US leading | `us_*`, FRED/BLS, world index, VIX-inspired context | Morning setup replacement candidate. | Dataset latency and licensing. |
| Taiwan macro | M1B/M2, business indicators, PMI/NMI, valuation distribution | Regime V4 shadow features. | Low update frequency. |

## Taxonomy Contract

StockVision V4 should use four source-tagged label layers:

```text
industry:
  FinLab security_categories.category

industry_theme:
  parent theme from security_industry_themes, when category is hierarchical

subindustry:
  FinLab security_industry_themes cleaned child tag or standalone theme tag

concept:
  StockVision self-built concept stock JSON and theme research signals
```

Formal industry/subindustry labels answer "what business is this company in";
concept labels answer "what the market is currently trading". Sector flow and
institutional rotation must aggregate each layer separately to avoid counting
the same buy/sell flow multiple times.

## P2: Research Benchmark

| Family | Candidate | Why P2 |
|---|---|---|
| Qlib | FinLab + Qlib AI stock selection examples | Benchmark only until data leakage and transaction-cost assumptions are verified. |
| OpenFE | Automated feature generation | Useful for discovery, but generated features need strict leakage/freshness controls. |
| NEAT / genetic algorithms | Architecture, factor, or parameter search | Research challenger; can route to ML-pool or regime review by objective, but starts offline/shadow. |
| Transformer / MI-LSTM | Price, sequence, or market-state prediction | ML-pool for return/ranking objectives; regime challenger for market-state objectives; no direct decision authority. |
| RL | Portfolio, allocation, or policy learning | Research benchmark by default; regime challenger only for offline regime/risk-state research; never execution owner. |
| Genetic programming | Symbolic factor or rule search | ML-feature challenger by default; can route to ML-pool/regime review after leakage and complexity gates. |
| CNN K-line | Image-style chart learning | Benchmark only; explainability and regime stability concerns. |
| Smart ETF replication | 0056, 00919, 00905, 00900, 00733 | Useful factor-combination research, not direct trading logic. |
| Crypto / real estate examples | API, cloud scheduling, generic backtest methods | Methodology only; not StockVision Taiwan-equity production domain. |

## Reject

```text
Single-article annualized return claims.
Directly copying article strategy parameters.
Directly copying VIP article bodies into internal storage.
Letting FinLab Skill write production features.
Letting FinLab backtest output bypass StockVision backtest.
Letting FinLab backtest output modify recommendation score, rank, alpha, paper fill, or pending-buy state.
Letting FinLab execution own risk, quote, decision, or paper-trade fills.
Letting FinLab preview create a second D1 paper-trade lifecycle.
Letting FinLab execution preview submit live orders or return live order IDs in V4-26.
Letting GDELT/Finnhub/RSS/IR headlines become direct alpha without traceability, cleaning, and promotion evidence.
Marketing, course, event, and personal-workflow articles without data/feature/risk value.
```

## Promotion Contract

Implemented by:

```text
PROMOTION_GATE_CONTRACT.md
ml-controller/services/promotion_gate_contract.py
```

Every FinLab-derived feature must carry:

```text
source_article_url or api_namespace
dataset_candidate
feature_candidate
cleaning_rule
backtest_design
production_risk
adoption_priority
owner
shadow_start_date
promotion_gate_status
```

Promotion requires:

```text
schema/freshness checks pass
no look-ahead
IC / hit-rate evidence
turnover and transaction-cost evidence
drawdown / MAE-MFE evidence
regime-split evidence
paper-trade or recommendation-shadow evidence
Decision Engine contract review
```
