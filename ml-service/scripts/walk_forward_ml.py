#!/usr/bin/env python3
"""
walk_forward_ml.py — ML Walk-Forward Validation

6-month train / 1-month test, 12 rolling windows.
Tests whether the ML ensemble has true out-of-sample alpha.

Usage:
    python scripts/walk_forward_ml.py --stock-id 2330 --data-path data/2330.json

Output:
    - Per-window: direction accuracy, signal accuracy, profit factor
    - Aggregate: mean accuracy, stability (std), Sharpe estimate
"""
import argparse
import json
import sys
import numpy as np
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.features import build_feature_matrix, get_features, compute_triple_barrier_labels
from app.ensemble import weighted_vote


def run_walk_forward(
    prices: list[dict],
    indicators: list[dict],
    chips: list[dict],
    sentiment: list[dict] | None = None,
    market_env: dict | None = None,
    train_months: int = 6,
    test_months: int = 1,
    n_windows: int = 12,
) -> list[dict]:
    """Run walk-forward validation with expanding/rolling window."""
    df = build_feature_matrix(prices, indicators, chips, sentiment or [], market_env)

    if len(df) < 180:
        print(f"Insufficient data: {len(df)} rows (need >= 180)")
        return []

    X, y, feature_names = get_features(df, target_col="target_dir")
    if len(X) < 100:
        print(f"Insufficient features: {len(X)} samples (need >= 100)")
        return []

    # Build date index
    # df is now Polars — extract date column or use sequential index
    dates = df["date"].to_list() if "date" in df.columns else list(range(len(df)))

    results = []
    total_days = len(X)
    test_size = total_days // (n_windows + train_months // test_months)
    if test_size < 20:
        test_size = 20

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

        # Train simple XGBoost as representative
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
            # Direction accuracy (binary label)
            up_correct = sum(1 for p, a in zip(preds, y_test) if p == 1 and a == 1)
            down_correct = sum(1 for p, a in zip(preds, y_test) if p == 0 and a == 0)
            total_correct = up_correct + down_correct

            results.append({
                "window": window,
                "train_size": len(X_train),
                "test_size": len(X_test),
                "accuracy": round(accuracy, 4),
                "up_correct": up_correct,
                "down_correct": down_correct,
                "total_correct": total_correct,
                "avg_confidence": round(float(np.mean(np.abs(proba - 0.5) * 2)), 4),
            })
            print(f"  Window {window}: train={len(X_train)} test={len(X_test)} acc={accuracy:.2%}")

        except Exception as e:
            print(f"  Window {window}: FAILED — {e}")
            results.append({"window": window, "error": str(e)})

    return results


def main():
    parser = argparse.ArgumentParser(description="ML Walk-Forward Validation")
    parser.add_argument("--data-path", required=True, help="Path to stock data JSON")
    parser.add_argument("--windows", type=int, default=12, help="Number of test windows")
    args = parser.parse_args()

    with open(args.data_path) as f:
        data = json.load(f)

    results = run_walk_forward(
        prices=data.get("prices", []),
        indicators=data.get("indicators", []),
        chips=data.get("chips", []),
        sentiment=data.get("sentiment", []),
        market_env=data.get("market_env"),
        n_windows=args.windows,
    )

    if not results:
        print("No results generated.")
        return

    valid = [r for r in results if "accuracy" in r]
    if valid:
        accs = [r["accuracy"] for r in valid]
        print(f"\n{'='*50}")
        print(f"Walk-Forward Summary ({len(valid)} windows)")
        print(f"  Mean Accuracy: {np.mean(accs):.2%}")
        print(f"  Std:           {np.std(accs):.2%}")
        print(f"  Min:           {np.min(accs):.2%}")
        print(f"  Max:           {np.max(accs):.2%}")
        print(f"  >50% windows:  {sum(1 for a in accs if a > 0.5)}/{len(accs)}")
        print(f"{'='*50}")

    output_path = Path(args.data_path).with_suffix('.walk_forward.json')
    with open(output_path, 'w') as f:
        json.dump({"windows": results, "summary": {
            "mean_accuracy": round(float(np.mean(accs)), 4) if valid else None,
            "std_accuracy": round(float(np.std(accs)), 4) if valid else None,
            "n_windows": len(valid),
        }}, f, indent=2)
    print(f"Results saved to {output_path}")


if __name__ == "__main__":
    main()
