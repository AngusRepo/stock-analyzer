#!/usr/bin/env bash
# analyze_step9c_shadow.sh — #16 Step 9c / #30 dynamicExitPriority shadow review.
#
# Why this exists (2026-04-21):
#   paper.ts logRegimeShadow() 從 4/20 起 log hypothetical regime-conditional
#   exit cascade（reorder + multipliers）。migration_exit_shadow.sql 後，每筆
#   shadow 事件同步 insert 到 D1 `exit_shadow_log` 表。此 script 供 4/27 Wei
#   翻 `exit.dynamicExitPriorityEnabled` flag 前做 A/B 決策：
#     - 各 regime 下 actual exit action 分布
#     - hypothetical_mult 會讓 hardStop/atrTrail 實際改變幾筆
#     - 是否有明顯 regime-correlated pattern 值得打開 flag
#
# Usage:
#   bash scripts/analyze_step9c_shadow.sh            # default 7d window
#   bash scripts/analyze_step9c_shadow.sh 14         # 14d window
#   bash scripts/analyze_step9c_shadow.sh 30 verbose # 30d + dump raw rows
#
# Pre-req: wrangler authenticated; D1 `stockvision-db` accessible.

set -e

WINDOW_DAYS="${1:-7}"
VERBOSE="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/../worker"

if ! command -v wrangler >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "❌ wrangler/npx not in PATH" >&2
  exit 1
fi
WRANGLER="wrangler"
command -v wrangler >/dev/null 2>&1 || WRANGLER="npx wrangler"

cd "$WORKER_DIR"

echo "=== Step 9c Shadow Review — last ${WINDOW_DAYS}d ==="
echo ""

echo "── Total events (per caller) ──"
$WRANGLER d1 execute stockvision-db --remote --command \
  "SELECT caller, COUNT(*) AS n FROM exit_shadow_log \
   WHERE date >= date('now', '-${WINDOW_DAYS} days') \
   GROUP BY caller ORDER BY n DESC"
echo ""

echo "── Per-regime action distribution ──"
$WRANGLER d1 execute stockvision-db --remote --command \
  "SELECT regime, actual_action, COUNT(*) AS n FROM exit_shadow_log \
   WHERE date >= date('now', '-${WINDOW_DAYS} days') \
   GROUP BY regime, actual_action ORDER BY regime, n DESC"
echo ""

echo "── Regime distribution by date (sanity: HMM label stability) ──"
$WRANGLER d1 execute stockvision-db --remote --command \
  "SELECT date, regime, COUNT(*) AS n FROM exit_shadow_log \
   WHERE date >= date('now', '-${WINDOW_DAYS} days') \
   GROUP BY date, regime ORDER BY date DESC, n DESC"
echo ""

echo "── Multiplier footprint (samples — does regime actually move thresholds?) ──"
$WRANGLER d1 execute stockvision-db --remote --command \
  "SELECT regime, hypothetical_mult, COUNT(*) AS n FROM exit_shadow_log \
   WHERE date >= date('now', '-${WINDOW_DAYS} days') \
   GROUP BY regime, hypothetical_mult ORDER BY regime, n DESC LIMIT 20"
echo ""

echo "── Reorder pattern per regime (top-of-cascade rule) ──"
$WRANGLER d1 execute stockvision-db --remote --command \
  "SELECT regime, hypothetical_order, COUNT(*) AS n FROM exit_shadow_log \
   WHERE date >= date('now', '-${WINDOW_DAYS} days') \
   GROUP BY regime, hypothetical_order ORDER BY regime, n DESC LIMIT 20"
echo ""

if [ "$VERBOSE" = "verbose" ]; then
  echo "── Raw rows (last ${WINDOW_DAYS}d, most recent 50) ──"
  $WRANGLER d1 execute stockvision-db --remote --command \
    "SELECT ts, caller, symbol, regime, actual_action, actual_reason \
     FROM exit_shadow_log \
     WHERE date >= date('now', '-${WINDOW_DAYS} days') \
     ORDER BY ts DESC LIMIT 50"
  echo ""
fi

echo "=== Decision checklist (4/27 Wei) ==="
echo "  1. 各 regime event 數 ≥ 5 → 分布統計可信度 OK"
echo "  2. hypothetical_mult 跨 regime 確實不同 (bull vs bear hardStop/atrTrail 倍數不同)"
echo "  3. actual_action 分布是否 regime-correlated (若 bull/bear 同分布 → flag 可能低效)"
echo "  4. reorder 前/後的 top rule 不同 → 有 cascade-order 影響的 trade 存在"
echo "  5. 若 1-4 全綠 → 翻 flag：  npx wrangler kv key put --binding KV trading:config ..."
echo "     (or via /admin/config merge endpoint)"
