#!/usr/bin/env python3
"""
walk_forward_ml.py — ML Walk-Forward Validation with Per-Fold WFE Gate

6-month train / 1-month test, 12 rolling windows.
Tests whether the ML ensemble has true out-of-sample alpha AND
passes the per-fold WFE (Walk-Forward Efficiency) acceptance gate.

The gate rejects models where any fold is catastrophic (min-aggregation),
preventing tail-risk models from reaching production.

Usage:
    python scripts/walk_forward_ml.py --data-path data/2330.json
    python scripts/walk_forward_ml.py --data-path data/2330.json --gate-config gate.json

Output:
    - Per-window: accuracy, CAGR, MaxDD, Sharpe, WFE score
    - Aggregate: mean accuracy, min WFE, worst CAGR, worst DD
    - Gate decision: pass/fail with reasons

Exit code:
    0 — gate passed (or no gate if --no-gate)
    2 — gate failed (model should not be promoted)
"""
import argparse
import json
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.features import build_feature_matrix, get_features
from app.wfe import compute_fold_wfe, apply_wfe_gate, DEFAULT_CONFIG


def _extract_fold_bars_atr(df, test_start: int, test_end: int):
    """Extract bars (close/high/low dicts) + atr array for a test fold slice."""
    fold_df = df.slice(test_start, test_end - test_start)

    close = fold_df["close"].to_list() if "close" in fold_df.columns else []
    high = fold_df["high"].to_list() if "high" in fold_df.columns else close
    low = fold_df["low"].to_list() if "low" in fold_df.columns else close

    bars = [
        {"close": c, "high": h, "low": l}
        for c, h, l in zip(close, high, low)
    ]

    atr_col = None
    for cand in ("atr14", "atr_14", "atr"):
        if cand in fold_df.columns:
            atr_col = cand
            break

    if atr_col is not None:
        atr = np.asarray(fold_df[atr_col].to_list(), dtype=np.float64)
        atr = np.nan_to_num(atr, nan=0.0)
    else:
        # Fallback: synthesize ATR as 2% of close
        atr = np.asarray([(c * 0.02) if c else 0.0 for c in close], dtype=np.float64)

    return bars, atr


def run_walk_forward(
    prices: list[dict],
    indicators: list[dict],
    chips: list[dict],
    sentiment: list[dict] | None = None,
    market_env: dict | None = None,
    train_months: int = 6,
    test_months: int = 1,
    n_windows: int = 12,
    wfe_config: dict | None = None,
) -> list[dict]:
    """Run walk-forward validation with per-fold financial metrics."""
    df = build_feature_matrix(prices, indicators, chips, sentiment or [], market_env)

    if len(df) < 180:
        print(f"Insufficient data: {len(df)} rows (need >= 180)")
        return []

    X, y, feature_names = get_features(df, target_col="target_dir")
    if len(X) < 100:
        print(f"Insufficient features: {len(X)} samples (need >= 100)")
        return []

    results = []
    total_days = len(X)
    test_size = total_days // (n_windows + train_months // test_months)
    if test_size < 20:
        test_size = 20

    # Feature matrix and df may not be 1:1 aligned if get_features drops NaN rows.
    # Build an index map so bar/atr slices stay in sync with X/y.
    df_len = len(df)
    offset = df_len - total_days
    if offset < 0:
        offset = 0

    for window in range(n_windows):
        test_end = total_days - window * test_size
        test_start = test_end - test_size
        train_end = test_start

        if train_end < train_months * 20:
            break

        X_train, y_train = X[:train_end], y[:train_end]
        X_test, y_test = X[test_start:test_end], y[test_start:test_end]

        if len(X_test) < 5:
            continue

        try:
            from xgboost import XGBClassifier
            model = XGBClassifier(
                n_estimators=150, max_depth=4, learning_rate=0.05,
                use_label_encoder=False, eval_metric='logloss', verbosity=0,
            )
            model.fit(X_train, y_train)
            preds = model.predict(X_test)
            proba = model.predict_proba(X_test)[:, 1]

            accuracy = float(np.mean(preds == y_test))
            up_correct = sum(1 for p, a in zip(preds, y_test) if p == 1 and a == 1)
            down_correct = sum(1 for p, a in zip(preds, y_test) if p == 0 and a == 0)
            total_correct = up_correct + down_correct

            # ── Per-fold WFE (financial metrics) ─────────────────────────────
            bars, atr = _extract_fold_bars_atr(
                df, offset + test_start, offset + test_end
            )
            fold_wfe = compute_fold_wfe(
                window=window,
                preds=preds,
                proba_up=proba,
                bars=bars,
                atr=atr,
                cfg=wfe_config,
            )

            results.append({
                "window": window,
                "train_size": len(X_train),
                "test_size": len(X_test),
                "accuracy": round(accuracy, 4),
                "up_correct": up_correct,
                "down_correct": down_correct,
                "total_correct": total_correct,
                "avg_confidence": round(float(np.mean(np.abs(proba - 0.5) * 2)), 4),
                # WFE fields
                "n_trades": fold_wfe.n_trades,
                "cagr": fold_wfe.cagr,
                "max_dd": fold_wfe.max_dd,
                "sharpe": fold_wfe.sharpe,
                "win_rate": fold_wfe.win_rate,
                "avg_trade_pnl_pct": fold_wfe.avg_trade_pnl_pct,
                "wfe_score": fold_wfe.wfe_score,
            })
            print(
                f"  Window {window}: train={len(X_train)} test={len(X_test)} "
                f"acc={accuracy:.2%} trades={fold_wfe.n_trades} "
                f"cagr={fold_wfe.cagr:+.2%} dd={fold_wfe.max_dd:+.2%} "
                f"wfe={fold_wfe.wfe_score:+.2f}"
            )

        except Exception as e:
            print(f"  Window {window}: FAILED — {e}")
            results.append({"window": window, "error": str(e)})

    return results


def main():
    parser = argparse.ArgumentParser(description="ML Walk-Forward Validation")
    parser.add_argument("--data-path", required=True, help="Path to stock data JSON")
    parser.add_argument("--windows", type=int, default=12, help="Number of test windows")
    parser.add_argument(
        "--gate-config", help="Path to JSON overrides for WFE gate thresholds"
    )
    parser.add_argument(
        "--no-gate", action="store_true",
        help="Skip gate decision (still compute metrics)"
    )
    args = parser.parse_args()

    wfe_config = None
    if args.gate_config:
        with open(args.gate_config) as f:
            wfe_config = json.load(f)

    with open(args.data_path) as f:
        data = json.load(f)

    results = run_walk_forward(
        prices=data.get("prices", []),
        indicators=data.get("indicators", []),
        chips=data.get("chips", []),
        sentiment=data.get("sentiment", []),
        market_env=data.get("market_env"),
        n_windows=args.windows,
        wfe_config=wfe_config,
    )

    if not results:
        print("No results generated.")
        return 1

    valid = [r for r in results if "accuracy" in r]
    gate_result = None

    if valid:
        accs = [r["accuracy"] for r in valid]
        cagrs = [r["cagr"] for r in valid if r.get("n_trades", 0) > 0]
        dds = [r["max_dd"] for r in valid if r.get("n_trades", 0) > 0]
        scores = [r["wfe_score"] for r in valid if r.get("n_trades", 0) > 0]

        print(f"\n{'='*60}")
        print(f"Walk-Forward Summary ({len(valid)} windows)")
        print(f"  Mean Accuracy: {np.mean(accs):.2%}  (std {np.std(accs):.2%})")
        print(f"  Min/Max Acc:   {np.min(accs):.2%} / {np.max(accs):.2%}")
        if cagrs:
            print(f"  Fold CAGR:     worst={min(cagrs):+.2%}  "
                  f"median={float(np.median(cagrs)):+.2%}  best={max(cagrs):+.2%}")
            print(f"  Fold MaxDD:    worst={min(dds):+.2%}  "
                  f"median={float(np.median(dds)):+.2%}")
            print(f"  WFE Score:     worst={min(scores):+.2f}  "
                  f"median={float(np.median(scores)):+.2f}")
        print(f"{'='*60}")

        if not args.no_gate:
            fold_wfe_dicts = [
                {
                    "window": r["window"],
                    "n_trades": r.get("n_trades", 0),
                    "cagr": r.get("cagr", 0.0),
                    "max_dd": r.get("max_dd", 0.0),
                    "sharpe": r.get("sharpe"),
                    "win_rate": r.get("win_rate", 0.0),
                    "avg_trade_pnl_pct": r.get("avg_trade_pnl_pct", 0.0),
                    "wfe_score": r.get("wfe_score", 0.0),
                }
                for r in valid
            ]
            gate = apply_wfe_gate(fold_wfe_dicts, cfg=wfe_config)
            gate_result = gate.to_dict()
            print(f"\n{'─'*60}")
            print(f"WFE Gate: {'PASS ✓' if gate.gate_pass else 'FAIL ✗'}")
            print(f"  min_wfe_score:   {gate.min_wfe_score:+.2f}")
            print(f"  worst_fold_cagr: {gate.worst_fold_cagr:+.2%}")
            print(f"  worst_fold_dd:   {gate.worst_fold_dd:+.2%}")
            if gate.fail_reasons:
                print(f"  reasons: {gate.fail_reasons}")
            print(f"{'─'*60}")

    summary = {
        "mean_accuracy": round(float(np.mean(accs)), 4) if valid else None,
        "std_accuracy": round(float(np.std(accs)), 4) if valid else None,
        "n_windows": len(valid),
    }
    if valid and cagrs:
        summary["worst_fold_cagr"] = round(float(min(cagrs)), 4)
        summary["worst_fold_dd"] = round(float(min(dds)), 4)
        summary["min_wfe_score"] = round(float(min(scores)), 4)

    output_path = Path(args.data_path).with_suffix('.walk_forward.json')
    with open(output_path, 'w') as f:
        json.dump(
            {"windows": results, "summary": summary, "gate": gate_result},
            f, indent=2
        )
    print(f"Results saved to {output_path}")

    # Exit code for CI / pipeline gating
    if gate_result and not gate_result.get("gate_pass"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
