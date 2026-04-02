#!/bin/bash
set -e

# ── Freqtrade W2: Hyperopt parameter optimization ──────────────────────────
# Usage: ./run_hyperopt.sh [EPOCHS] [TIMERANGE]
# Default: 500 epochs, last 6 months
#
# Optimizes buy_confidence, hard_stop_pct, tp1_mult, tp2_mult, etc.
# Results stored in user_data/hyperopt_results/

EPOCHS=${1:-500}
TIMERANGE=${2:-"20250901-20260327"}
STRATEGY="StockVisionStrategy"
LOSS_FUNCTION="SharpeHyperOptLoss"

echo "=== Hyperopt: ${EPOCHS} epochs, ${TIMERANGE}, loss=${LOSS_FUNCTION} ==="

# Step 1: Export D1 data (if not already present)
if [ ! -d "/freqtrade/user_data/data/signals" ] || [ -z "$(ls /freqtrade/user_data/data/signals/ 2>/dev/null)" ]; then
  echo "[Step 1] Exporting D1 data..."
  python /freqtrade/scripts/export_d1.py
else
  echo "[Step 1] Signals data exists, skipping export"
fi

# Step 2: Run hyperopt
echo "[Step 2] Running hyperopt..."
freqtrade hyperopt \
  --strategy "$STRATEGY" \
  --hyperopt-loss "$LOSS_FUNCTION" \
  --timerange "$TIMERANGE" \
  --epochs "$EPOCHS" \
  --spaces buy sell \
  --min-trades 20 \
  --no-color \
  -j 2

# Step 3: Show best result
echo ""
echo "=== Best parameters ==="
freqtrade hyperopt-show --best --no-header

echo ""
echo "=== Top 10 results ==="
freqtrade hyperopt-list --min-trades 20 --print-json --limit 10
