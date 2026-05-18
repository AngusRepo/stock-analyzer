# Market Regime State Contract

Generated: 2026-05-16

## Purpose

`market_regime_state` is the V4 downstream contract for broad-market regime.
It replaces direct downstream reads of `ml:regime` while keeping `ml:regime`
and `ml:regime:meta` as migration mirrors.

## Producer Flow

```text
ml-service /regime/current
  -> ml-controller /regime/compute
  -> Worker /api/admin/optuna-push source=regime
  -> KV market_regime_state
  -> legacy mirrors: ml:regime, ml:regime:meta
```

## KV Envelope

```json
{
  "schema_version": "market-regime-state-v1",
  "label": "bull_market | bear_market | volatile | sideways",
  "raw_label": "bull_market | bear_market | volatile | sideways",
  "family": "bull | bear | volatile | sideways",
  "run_date": "YYYY-MM-DD",
  "computed_at": "ISO-8601",
  "source": "hmm",
  "regime_index": 0,
  "hmm_state": 0,
  "label_zh": "",
  "regime_surface": {
    "bull_market": 0.64,
    "sideways": 0.24
  },
  "consensus_threshold": 0.6,
  "weight_multipliers": {},
  "regime_evidence": {
    "schema_version": "regime-evidence-v1",
    "decision_policy": "bear_market_requires_cross_evidence_confirmation",
    "raw_label": "bear_market",
    "effective_label": "volatile | bear_market",
    "support_counts": {
      "bearish": 2,
      "bullish": 0,
      "available": 4,
      "missing": 3
    },
    "evidence": {
      "price_trend": {},
      "breadth": {},
      "atr_vturn": {},
      "leverage": {},
      "valuation": {},
      "macro_liquidity": {},
      "global_risk": {}
    }
  },
  "transition_guard": {
    "status": "confirmed | blocked | warning | not_required",
    "reason": "cross_evidence_confirmed | insufficient_cross_evidence_for_bear"
  },
  "monitors": {
    "lppls_weekly_bubble": {
      "status": "warning | available | insufficient_data",
      "score": 0.0,
      "warning_threshold": 0.7,
      "method": "lppls_weekly_proxy_v1",
      "decision_effect": "context_only"
    },
    "hawkes_contagion": {
      "status": "warning | available | insufficient_data",
      "score": 0.0,
      "warning_threshold": 0.7,
      "method": "hawkes_exponential_decay_proxy_v1",
      "decision_effect": "context_only"
    }
  },
  "downstream_contract": {
    "primary_kv_key": "market_regime_state",
    "legacy_mirror_keys": ["ml:regime", "ml:regime:meta"],
    "read_policy": "market_regime_state_first_legacy_fallback"
  }
}
```

## Downstream Consumers

- Worker `tradingConfig.getCurrentRegime`: SL/TP per-regime overlay.
- Worker `paperMarketData.getCurrentRegime`: paper entry/exit and regime shadow logs.
- Worker `adaptiveConfig.getAdaptiveParamsForRegime`: adaptive deltas and bandit protection.
- Worker `controllerDailyWorkflows.runRegimeCompute`: previous-label shift detection.
- Controller `payload_builder.load_effective_adaptive_params`: ML payload adaptive overlay.
- Controller `daily_pipeline_v2.node_recommend`: recommendation alpha weighting and ranking allocation.

## Migration Rule

Readers must use:

```text
market_regime_state -> ml:regime:meta -> ml:regime -> missing
```

Writers for `source=regime` must write:

```text
market_regime_state
ml:regime
ml:regime:meta
```

The old keys are mirrors only. New downstream work must not read them directly.

## Failure Policy

Before recommendation, missing `market_regime_state` plus missing legacy mirrors
is fail-closed. The pipeline must stop with:

```text
market_regime_state missing before recommendation; run regime-compute before pipeline
```

This prevents the new V4 regime stack from becoming an observation-only sidecar.

## Future Inputs

The same envelope can absorb V4 regime evidence without changing downstream
consumers:

- breadth and market structure
- ATR V-turn / volatility state
- margin maintenance and leverage stress
- valuation distribution
- macro and world-index context
- LPPLS weekly bubble monitor
- Hawkes contagion monitor
- challenger outputs for HMM / adaptive / Transformer / RL / GP research

Promotion still requires separate validation gates. Monitors emit context and
warnings before they affect position sizing, recommendation ranking, or risk.

The current V4-18 monitor implementation is intentionally a production-safe
proxy layer: LPPLS uses weekly super-exponential acceleration features, and
Hawkes uses exponential-decay clustering of negative shock events. They are
named as monitors, not trading signals, until research validation promotes a
full nonlinear LPPLS fit or a calibrated Hawkes process.

## Bear Transition Guard

`bear_market` requires cross-evidence confirmation. A raw HMM `bear_market`
label is stored as `raw_label`, but the downstream `label` becomes `volatile`
when bearish evidence is limited to short-term price weakness. Confirmation
currently requires at least three bearish dimensions plus confirmation from
breadth/global risk and volatility/leverage. This prevents a two-session selloff
from immediately flipping downstream alpha, SL/TP, and recommendation behavior.
