#!/bin/bash
set -e

# Cloud Run Job entrypoint: D1 export → backtest → import results
# Usage: CF_API_TOKEN=xxx ./run_backtest.sh [timerange]

TIMERANGE="${1:-20240101-$(date +%Y%m%d)}"
echo "=== StockVision Backtest Pipeline ==="
echo "Timerange: ${TIMERANGE}"
echo ""

# Step 1: Export OHLCV + signals from D1
echo "📊 Step 1: Exporting data from D1..."
python /freqtrade/scripts/export_d1.py

# Step 2: Run backtest
echo ""
echo "🔬 Step 2: Running backtest..."
freqtrade backtesting \
  --strategy StockVisionStrategy \
  --config /freqtrade/config.json \
  --timerange "${TIMERANGE}" \
  --export trades

# Step 3: Import results back to D1
echo ""
echo "📤 Step 3: Importing results to D1..."
python /freqtrade/scripts/import_results.py

# Step 4: Cross-validate with paper trading
echo ""
echo "🔍 Step 4: Cross-validation..."
python /freqtrade/scripts/validate_vs_paper.py

echo ""
echo "🎯 Done!"
