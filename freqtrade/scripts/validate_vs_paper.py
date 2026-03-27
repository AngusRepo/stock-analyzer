#!/usr/bin/env python3
"""
validate_vs_paper.py — 交叉驗證 Freqtrade 回測 vs Paper Trading 實際結果

比較項目：
  1. 同期間交易次數
  2. Win Rate
  3. 平均獲利 / 平均虧損
  4. Sharpe Ratio (if available)
  5. Max Drawdown
  6. 出場分佈 (TP1/TP2/Stop/Time)

差異 > 10% 的項目標紅。
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests

# ── Config ──────────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '619a83ac9f20847d9e2f2920823b727d')
CF_D1_DB_ID   = os.environ.get('CF_D1_DB_ID', '6401a5f6-5767-4fa8-a1a7-ec8d4739ac79')
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN', '')

D1_API = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query'

BACKTEST_DIR = Path(__file__).parent.parent / 'user_data' / 'backtest_results'


def d1_query(sql: str, params: list = None) -> list[dict]:
    """Execute a D1 SQL query via REST API."""
    if not CF_API_TOKEN:
        print('ERROR: CF_API_TOKEN not set')
        sys.exit(1)

    body = {'sql': sql}
    if params:
        body['params'] = params

    resp = requests.post(D1_API, json=body, headers={
        'Authorization': f'Bearer {CF_API_TOKEN}',
        'Content-Type': 'application/json',
    })

    if resp.status_code != 200:
        return []

    data = resp.json()
    if not data.get('success'):
        return []

    results = data.get('result', [])
    if results and isinstance(results, list) and 'results' in results[0]:
        return results[0]['results']
    return []


def load_backtest_results() -> dict:
    """Load latest Freqtrade backtest result JSON."""
    if not BACKTEST_DIR.exists():
        print(f'❌ Backtest results dir not found: {BACKTEST_DIR}')
        return {}

    # Find latest result file
    result_files = sorted(BACKTEST_DIR.glob('backtest-result-*.json'), reverse=True)
    if not result_files:
        # Also check for .meta files
        result_files = sorted(BACKTEST_DIR.glob('*.json'), reverse=True)

    if not result_files:
        print('❌ No backtest result files found')
        return {}

    latest = result_files[0]
    print(f'📊 Loading backtest: {latest.name}')

    with open(latest) as f:
        return json.load(f)


def load_paper_stats(start_date: str, end_date: str) -> dict:
    """Load paper trading stats from D1 for the given period."""
    print(f'📊 Loading paper trading stats: {start_date} ~ {end_date}')

    # Total trades
    orders = d1_query(
        "SELECT * FROM paper_orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at",
        [start_date, end_date + 'T23:59:59']
    )

    if not orders:
        print('⚠️  No paper orders found in this period')
        return {}

    # Pair up buy→sell trades
    trades = []
    open_positions: dict[str, dict] = {}

    for o in orders:
        sym = o['symbol']
        if o['side'] == 'buy':
            open_positions[sym] = o
        elif o['side'] == 'sell' and sym in open_positions:
            buy = open_positions.pop(sym)
            buy_price = buy['price']
            sell_price = o['price']
            pnl_pct = (sell_price - buy_price) / buy_price
            trades.append({
                'symbol': sym,
                'buy_price': buy_price,
                'sell_price': sell_price,
                'pnl_pct': pnl_pct,
                'note': o.get('note', ''),
                'buy_date': buy['created_at'],
                'sell_date': o['created_at'],
            })

    if not trades:
        return {}

    wins = [t for t in trades if t['pnl_pct'] > 0]
    losses = [t for t in trades if t['pnl_pct'] <= 0]

    # Exit distribution from notes
    tp1_count = sum(1 for t in trades if 'TP1' in (t['note'] or ''))
    tp2_count = sum(1 for t in trades if 'TP2' in (t['note'] or ''))
    stop_count = sum(1 for t in trades if any(k in (t['note'] or '') for k in ['stop', 'Stop', '停損']))
    time_count = sum(1 for t in trades if any(k in (t['note'] or '') for k in ['time', 'Time', '到期']))

    # Snapshots for MDD / Sharpe
    snapshots = d1_query(
        "SELECT * FROM paper_daily_snapshots WHERE date >= ? AND date <= ? ORDER BY date",
        [start_date, end_date]
    )

    mdd = None
    sharpe = None
    if snapshots:
        mdd_vals = [s.get('max_drawdown_to_date') for s in snapshots if s.get('max_drawdown_to_date') is not None]
        if mdd_vals:
            mdd = max(mdd_vals)

        sharpe_vals = [s.get('sharpe_30d') for s in snapshots if s.get('sharpe_30d') is not None]
        if sharpe_vals:
            sharpe = sharpe_vals[-1]  # latest

    return {
        'total_trades': len(trades),
        'win_rate': len(wins) / len(trades) if trades else 0,
        'avg_win_pct': sum(t['pnl_pct'] for t in wins) / len(wins) if wins else 0,
        'avg_loss_pct': sum(t['pnl_pct'] for t in losses) / len(losses) if losses else 0,
        'max_drawdown': mdd,
        'sharpe': sharpe,
        'tp1_count': tp1_count,
        'tp2_count': tp2_count,
        'stop_count': stop_count,
        'time_count': time_count,
    }


def extract_backtest_stats(bt: dict) -> dict:
    """Extract comparable stats from Freqtrade backtest result JSON."""
    # Freqtrade stores results under strategy name key
    strategy_results = None
    for key, val in bt.items():
        if isinstance(val, dict) and 'trades' in val:
            strategy_results = val
            break

    if not strategy_results:
        # Try newer format
        if 'strategy' in bt:
            for key, val in bt['strategy'].items():
                strategy_results = val
                break

    if not strategy_results:
        print('⚠️  Cannot parse backtest result format')
        return {}

    trades = strategy_results.get('trades', [])
    if not trades:
        return {}

    wins = [t for t in trades if t.get('profit_ratio', 0) > 0]
    losses = [t for t in trades if t.get('profit_ratio', 0) <= 0]

    # Exit reasons
    exit_reasons = {}
    for t in trades:
        reason = t.get('exit_reason', t.get('sell_reason', 'unknown'))
        exit_reasons[reason] = exit_reasons.get(reason, 0) + 1

    tp1_count = sum(v for k, v in exit_reasons.items() if 'TP1' in k)
    tp2_count = sum(v for k, v in exit_reasons.items() if 'TP2' in k)
    stop_count = sum(v for k, v in exit_reasons.items() if 'stop' in k.lower() or 'stoploss' in k.lower())
    time_count = sum(v for k, v in exit_reasons.items() if 'time' in k.lower() or 'Time' in k)

    # MDD from strategy results
    mdd = strategy_results.get('max_drawdown', strategy_results.get('max_drawdown_account'))
    sharpe = strategy_results.get('sharpe')

    return {
        'total_trades': len(trades),
        'win_rate': len(wins) / len(trades) if trades else 0,
        'avg_win_pct': sum(t['profit_ratio'] for t in wins) / len(wins) if wins else 0,
        'avg_loss_pct': sum(t['profit_ratio'] for t in losses) / len(losses) if losses else 0,
        'max_drawdown': mdd,
        'sharpe': sharpe,
        'tp1_count': tp1_count,
        'tp2_count': tp2_count,
        'stop_count': stop_count,
        'time_count': time_count,
    }


def compare(paper: dict, bt: dict):
    """Compare paper vs backtest and print report."""
    print('\n' + '=' * 70)
    print('  StockVision: Paper Trading vs Freqtrade Backtest')
    print('=' * 70)

    if not paper or not bt:
        print('⚠️  Missing data — cannot compare')
        if not paper:
            print('   Paper trading: no data')
        if not bt:
            print('   Backtest: no data')
        return

    metrics = [
        ('Total Trades',    'total_trades',  '{:.0f}', '{:.0f}'),
        ('Win Rate',        'win_rate',      '{:.1%}', '{:.1%}'),
        ('Avg Win %',       'avg_win_pct',   '{:.2%}', '{:.2%}'),
        ('Avg Loss %',      'avg_loss_pct',  '{:.2%}', '{:.2%}'),
        ('Max Drawdown',    'max_drawdown',  '{:.2%}', '{:.2%}'),
        ('Sharpe Ratio',    'sharpe',        '{:.2f}', '{:.2f}'),
        ('TP1 Exits',       'tp1_count',     '{:.0f}', '{:.0f}'),
        ('TP2 Exits',       'tp2_count',     '{:.0f}', '{:.0f}'),
        ('Stop Exits',      'stop_count',    '{:.0f}', '{:.0f}'),
        ('Time Exits',      'time_count',    '{:.0f}', '{:.0f}'),
    ]

    print(f'\n{"Metric":<18} {"Paper":>12} {"Backtest":>12} {"Diff":>10}  {"Status"}')
    print('-' * 70)

    for label, key, fmt_p, fmt_b in metrics:
        p_val = paper.get(key)
        b_val = bt.get(key)

        if p_val is None and b_val is None:
            print(f'{label:<18} {"N/A":>12} {"N/A":>12} {"":>10}  ⬜')
            continue

        p_str = fmt_p.format(p_val) if p_val is not None else 'N/A'
        b_str = fmt_b.format(b_val) if b_val is not None else 'N/A'

        # Calculate relative difference
        if p_val is not None and b_val is not None and p_val != 0:
            diff = abs(b_val - p_val) / abs(p_val)
            diff_str = f'{diff:.1%}'
            if diff > 0.10:
                status = '🔴 >10%'
            elif diff > 0.05:
                status = '🟡 >5%'
            else:
                status = '🟢 OK'
        elif p_val is not None and b_val is not None:
            diff_str = f'{abs(b_val - p_val):.2f}'
            status = '🟢' if abs(b_val - p_val) < 0.01 else '🟡'
        else:
            diff_str = '-'
            status = '⬜ N/A'

        print(f'{label:<18} {p_str:>12} {b_str:>12} {diff_str:>10}  {status}')

    print()


if __name__ == '__main__':
    # Default: compare full available period
    start = '2024-01-01'
    end = '2026-03-26'

    if len(sys.argv) >= 3:
        start = sys.argv[1]
        end = sys.argv[2]

    bt_data = load_backtest_results()
    bt_stats = extract_backtest_stats(bt_data) if bt_data else {}

    paper_stats = load_paper_stats(start, end)

    compare(paper_stats, bt_stats)

    if not bt_stats:
        print('💡 Run backtest first:')
        print('   freqtrade backtesting --strategy StockVisionStrategy --config config.json')
    if not paper_stats:
        print('💡 Paper trading has no orders in this period.')
        print('   Make sure CF_API_TOKEN is set and paper_orders table has data.')
