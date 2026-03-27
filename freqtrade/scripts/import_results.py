#!/usr/bin/env python3
"""
import_results.py — 將 Freqtrade 回測結果寫回 Cloudflare D1

讀取 user_data/backtest_results/ 最新 JSON → INSERT INTO backtest_results
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

# ── Config ──────────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '619a83ac9f20847d9e2f2920823b727d')
CF_D1_DB_ID   = os.environ.get('CF_D1_DB_ID', '6401a5f6-5767-4fa8-a1a7-ec8d4739ac79')
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN', '')

D1_API = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query'

BACKTEST_DIR = Path(__file__).parent.parent / 'user_data' / 'backtest_results'


def d1_exec(sql: str, params: list = None) -> bool:
    """Execute a D1 SQL statement."""
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
        print(f'D1 API error {resp.status_code}: {resp.text[:200]}')
        return False

    data = resp.json()
    if not data.get('success'):
        print(f'D1 exec failed: {data.get("errors", [])}')
        return False

    return True


def find_latest_result() -> tuple[Path | None, dict]:
    """Find and parse the latest backtest result."""
    if not BACKTEST_DIR.exists():
        print(f'❌ Dir not found: {BACKTEST_DIR}')
        return None, {}

    # Freqtrade outputs: backtest-result-YYYY-MM-DD_HH-MM-SS.json
    result_files = sorted(BACKTEST_DIR.glob('backtest-result-*.json'), reverse=True)
    if not result_files:
        result_files = sorted(BACKTEST_DIR.glob('*.json'), reverse=True)

    if not result_files:
        print('❌ No backtest result files')
        return None, {}

    latest = result_files[0]
    print(f'📊 Reading: {latest.name}')

    with open(latest) as f:
        data = json.load(f)

    return latest, data


def extract_metrics(data: dict) -> dict | None:
    """Extract key metrics from Freqtrade backtest JSON."""
    # Find strategy results — Freqtrade nests under strategy name
    strategy_data = None
    strategy_name = 'StockVisionStrategy'

    # Format 1: {strategy_name: {trades: [...], ...}}
    if strategy_name in data:
        strategy_data = data[strategy_name]
    else:
        # Format 2: {strategy: {strategy_name: {...}}}
        strat_section = data.get('strategy', data)
        for key, val in strat_section.items():
            if isinstance(val, dict) and ('trades' in val or 'total_trades' in val):
                strategy_data = val
                strategy_name = key
                break

    if not strategy_data:
        print('⚠️  Cannot find strategy results in backtest JSON')
        return None

    trades = strategy_data.get('trades', [])
    total = len(trades)

    if total == 0:
        print('⚠️  No trades in backtest result')
        return None

    wins = [t for t in trades if t.get('profit_ratio', 0) > 0]
    losses = [t for t in trades if t.get('profit_ratio', 0) <= 0]

    # Profit factor
    gross_profit = sum(t['profit_ratio'] for t in wins) if wins else 0
    gross_loss = abs(sum(t['profit_ratio'] for t in losses)) if losses else 0.001
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0

    # Expectancy = avg_win * win_rate - avg_loss * loss_rate
    win_rate = len(wins) / total
    avg_win = gross_profit / len(wins) if wins else 0
    avg_loss = gross_loss / len(losses) if losses else 0
    expectancy = avg_win * win_rate - avg_loss * (1 - win_rate)

    return {
        'strategy': strategy_name,
        'timerange': strategy_data.get('timerange', data.get('timerange', '')),
        'total_trades': total,
        'win_rate': win_rate,
        'sharpe': strategy_data.get('sharpe'),
        'sortino': strategy_data.get('sortino'),
        'calmar': strategy_data.get('calmar'),
        'max_drawdown': strategy_data.get('max_drawdown', strategy_data.get('max_drawdown_account')),
        'cagr': strategy_data.get('cagr', strategy_data.get('backtest_best_day')),
        'profit_factor': profit_factor,
        'expectancy': expectancy,
    }


def import_to_d1(metrics: dict, raw_json: str):
    """Insert backtest results into D1 backtest_results table."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    sql = """
        INSERT OR REPLACE INTO backtest_results
        (run_date, strategy, timerange, total_trades, win_rate,
         sharpe, sortino, calmar, max_drawdown, cagr,
         profit_factor, expectancy, raw_results)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        today,
        metrics['strategy'],
        metrics['timerange'],
        metrics['total_trades'],
        metrics['win_rate'],
        metrics['sharpe'],
        metrics['sortino'],
        metrics['calmar'],
        metrics['max_drawdown'],
        metrics['cagr'],
        metrics['profit_factor'],
        metrics['expectancy'],
        raw_json[:50000],  # Truncate raw JSON to 50KB
    ]

    if d1_exec(sql, params):
        print(f'✅ Imported to D1: {today} / {metrics["strategy"]}')
        print(f'   Trades: {metrics["total_trades"]}, Win Rate: {metrics["win_rate"]:.1%}')
        print(f'   Sharpe: {metrics["sharpe"]}, MDD: {metrics["max_drawdown"]}')
        print(f'   Profit Factor: {metrics["profit_factor"]:.2f}, Expectancy: {metrics["expectancy"]:.4f}')
    else:
        print('❌ Failed to import to D1')


if __name__ == '__main__':
    print('=' * 60)
    print('Freqtrade Backtest → D1 Import')
    print('=' * 60)

    path, data = find_latest_result()
    if not data:
        sys.exit(1)

    metrics = extract_metrics(data)
    if not metrics:
        sys.exit(1)

    # Serialize raw JSON (trimmed)
    raw = json.dumps(data, ensure_ascii=False)
    import_to_d1(metrics, raw)
