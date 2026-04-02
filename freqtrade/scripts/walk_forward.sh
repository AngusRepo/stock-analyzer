#!/bin/bash
set -e

# ── Freqtrade W2: Walk-Forward Validation ──────────────────────────────────
# Splits data into rolling windows: train N months → test 1 month
# Validates that hyperopt results generalize (not overfit)
#
# Usage: ./walk_forward.sh [TRAIN_MONTHS] [TEST_MONTHS] [EPOCHS]
# Default: 4 months train, 1 month test, 200 epochs per window

TRAIN_MONTHS=${1:-4}
TEST_MONTHS=${2:-1}
EPOCHS=${3:-200}
STRATEGY="StockVisionStrategy"
LOSS="SharpeHyperOptLoss"
RESULTS_DIR="/freqtrade/user_data/walk_forward_results"

mkdir -p "$RESULTS_DIR"

# Generate date windows (last 6 months = ~5 windows)
echo "=== Walk-Forward Validation ==="
echo "Train: ${TRAIN_MONTHS}m | Test: ${TEST_MONTHS}m | Epochs: ${EPOCHS}"
echo ""

# Windows: train on [start, start+4m), test on [start+4m, start+5m)
WINDOWS=(
  "20250801-20251201:20251201-20260101"
  "20250901-20260101:20260101-20260201"
  "20251001-20260201:20260201-20260301"
  "20251101-20260301:20260301-20260327"
)

TOTAL_PROFIT=0
TOTAL_TRADES=0
TOTAL_WINS=0
WINDOW_RESULTS=""

for i in "${!WINDOWS[@]}"; do
  IFS=':' read -r TRAIN_RANGE TEST_RANGE <<< "${WINDOWS[$i]}"
  WIN_NUM=$((i + 1))
  echo "─── Window ${WIN_NUM}/${#WINDOWS[@]}: train=${TRAIN_RANGE} test=${TEST_RANGE} ───"

  # Hyperopt on train set
  echo "[${WIN_NUM}] Hyperopt (${EPOCHS} epochs)..."
  freqtrade hyperopt \
    --strategy "$STRATEGY" \
    --hyperopt-loss "$LOSS" \
    --timerange "$TRAIN_RANGE" \
    --epochs "$EPOCHS" \
    --spaces buy sell \
    --min-trades 10 \
    --no-color \
    -j 2 2>/dev/null || { echo "[${WIN_NUM}] Hyperopt failed, skip"; continue; }

  # Apply best params and backtest on test set
  echo "[${WIN_NUM}] Backtest on test set..."
  RESULT=$(freqtrade backtesting \
    --strategy "$STRATEGY" \
    --timerange "$TEST_RANGE" \
    --no-color 2>&1 || echo "FAILED")

  # Extract key metrics
  PROFIT=$(echo "$RESULT" | grep -oP 'TOTAL.*?\|\s*\K[-\d.]+(?=\s*\|)' | tail -1 || echo "0")
  TRADES=$(echo "$RESULT" | grep -oP 'TOTAL.*?\|\s*\K\d+' | head -1 || echo "0")

  echo "[${WIN_NUM}] Test profit: ${PROFIT}% | Trades: ${TRADES}"
  WINDOW_RESULTS="${WINDOW_RESULTS}Window ${WIN_NUM} (${TEST_RANGE}): profit=${PROFIT}% trades=${TRADES}\n"
  echo ""
done

echo ""
echo "═══════════════════════════════════════"
echo "Walk-Forward Summary:"
echo -e "$WINDOW_RESULTS"
echo "═══════════════════════════════════════"

# Save results
echo -e "$WINDOW_RESULTS" > "${RESULTS_DIR}/summary_$(date +%Y%m%d).txt"
echo "Results saved to ${RESULTS_DIR}/summary_$(date +%Y%m%d).txt"
