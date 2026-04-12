#!/usr/bin/env python3
"""
export_d1.py — 從 Cloudflare D1 匯出 OHLCV + ML signals 給 Freqtrade

輸出格式：
  user_data/data/twse/{SYMBOL}-TWD/{SYMBOL}-TWD-1d.json
    → [[timestamp_ms, open, high, low, close, volume], ...]

  user_data/data/signals/{SYMBOL}.json
    → [{"date": "2026-01-01", "signal": "BUY", "confidence": 0.65, ...}, ...]
"""
import os
import sys
import json
import time
import requests
from datetime import datetime, timezone
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '619a83ac9f20847d9e2f2920823b727d')
CF_D1_DB_ID   = os.environ.get('CF_D1_DB_ID', '6401a5f6-5767-4fa8-a1a7-ec8d4739ac79')
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN', '')

DATA_DIR    = Path(__file__).parent.parent / 'user_data' / 'data'
TWSE_DIR    = DATA_DIR / 'twse'
SIGNALS_DIR = DATA_DIR / 'signals'

D1_API = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query'


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
        print(f'D1 API error {resp.status_code}: {resp.text[:200]}')
        return []

    data = resp.json()
    if not data.get('success'):
        print(f'D1 query failed: {data.get("errors", [])}')
        return []

    results = data.get('result', [])
    if results and isinstance(results, list) and 'results' in results[0]:
        return results[0]['results']
    return []


def date_to_ms(date_str: str) -> int:
    """Convert 'YYYY-MM-DD' to milliseconds since epoch (UTC)."""
    dt = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def export_ohlcv():
    """Export all active + watchlist stocks' OHLCV to Freqtrade JSON."""
    print('📊 Fetching stock list...')

    # D10 fix: export all tradable stocks (not just watchlist)
    stocks = d1_query("""
        SELECT DISTINCT s.id, s.symbol, s.name
        FROM stocks s
        WHERE s.delisted_date IS NULL
    """)

    if not stocks:
        print('No stocks found')
        return []

    print(f'Found {len(stocks)} stocks to export')
    exported = []
    pair_list = []

    for i, stock in enumerate(stocks):
        symbol = stock['symbol']
        stock_id = stock['id']

        # Fetch OHLCV
        rows = d1_query(
            'SELECT date, open, high, low, close, volume FROM stock_prices '
            'WHERE stock_id = ? ORDER BY date ASC',
            [stock_id]
        )

        if len(rows) < 30:
            print(f'  [{i+1}/{len(stocks)}] {symbol}: only {len(rows)} rows, skip')
            continue

        # Convert to Freqtrade format: [[timestamp_ms, O, H, L, C, V], ...]
        candles = []
        for r in rows:
            if not r.get('date') or r.get('close') is None:
                continue
            candles.append([
                date_to_ms(r['date']),
                float(r.get('open') or r['close']),
                float(r.get('high') or r['close']),
                float(r.get('low') or r['close']),
                float(r['close']),
                float(r.get('volume') or 0),
            ])

        # Write to Freqtrade path: twse/{SYMBOL}-TWD/{SYMBOL}-TWD-1d.json
        pair_name = f'{symbol}-TWD'
        pair_dir = TWSE_DIR / pair_name
        pair_dir.mkdir(parents=True, exist_ok=True)
        out_file = pair_dir / f'{pair_name}-1d.json'

        with open(out_file, 'w') as f:
            json.dump(candles, f)

        exported.append(symbol)
        pair_list.append(f'{symbol}/TWD')
        print(f'  [{i+1}/{len(stocks)}] {symbol}: {len(candles)} candles → {out_file.name}')

        # Rate limit: D1 API ~100 req/min
        if (i + 1) % 20 == 0:
            time.sleep(2)

    print(f'\n✅ Exported {len(exported)} stocks')
    return pair_list


def export_signals():
    """Export ML predictions as signal files for the strategy."""
    print('\n🤖 Fetching ML predictions...')

    # Get predictions from last 2 years
    predictions = d1_query("""
        SELECT p.stock_id, s.symbol, p.generated_at, p.trade_signal,
               p.direction_accuracy, p.entry_price, p.stop_loss,
               p.target1, p.target2, p.forecast_data
        FROM predictions p
        JOIN stocks s ON s.id = p.stock_id
        WHERE p.model_name = 'ensemble'
          AND p.generated_at >= date('now', '-730 days')
        ORDER BY p.stock_id, p.generated_at
    """)

    if not predictions:
        print('No predictions found')
        return

    # Group by symbol
    by_symbol: dict[str, list] = {}
    for p in predictions:
        sym = p['symbol']
        if sym not in by_symbol:
            by_symbol[sym] = []

        # Parse forecast_data JSON
        fd = {}
        try:
            fd = json.loads(p.get('forecast_data') or '{}')
        except (json.JSONDecodeError, TypeError):
            pass

        by_symbol[sym].append({
            'date': (p.get('generated_at') or '')[:10],
            'signal': fd.get('signal') or p.get('trade_signal') or 'HOLD',
            'confidence': p.get('direction_accuracy') or 0,
            'entry_price': p.get('entry_price'),
            'stop_loss': p.get('stop_loss'),
            'target1': p.get('target1'),
            'target2': p.get('target2'),
        })

    SIGNALS_DIR.mkdir(parents=True, exist_ok=True)

    for sym, signals in by_symbol.items():
        out_file = SIGNALS_DIR / f'{sym}.json'
        with open(out_file, 'w') as f:
            json.dump(signals, f, indent=2)

    print(f'✅ Exported signals for {len(by_symbol)} stocks')


def update_config_pairlist(pair_list: list[str]):
    """Update config.json with exported pair whitelist."""
    config_path = Path(__file__).parent.parent / 'config.json'
    with open(config_path) as f:
        config = json.load(f)

    config['exchange']['pair_whitelist'] = pair_list
    config['exchange']['name'] = 'twse'  # custom exchange name for backtesting

    with open(config_path, 'w') as f:
        json.dump(config, f, indent=4)

    print(f'\n📝 Updated config.json with {len(pair_list)} pairs')


if __name__ == '__main__':
    print('=' * 60)
    print('StockVision D1 → Freqtrade Export')
    print('=' * 60)

    pair_list = export_ohlcv()
    export_signals()

    if pair_list:
        update_config_pairlist(pair_list)

    print('\n🎯 Done! Run backtest with:')
    print('  freqtrade backtesting --strategy StockVisionStrategy --config config.json')
