#!/usr/bin/env python3
"""
P0 #1 — Optuna Triple Barrier 參數搜尋

搜尋空間：
  upper_mult  [2.0, 4.0]
  lower_mult  [1.5, 3.0]
  pct_cap     [0.03, 0.10]
  max_days    [10, 30]

目標：最大化標籤品質（正負樣本方向準確率）
OOS 20% 鎖定驗證，防止過擬合
"""
import json
import sys
import os
from pathlib import Path

import numpy as np
import pandas as pd
import optuna
from optuna.samplers import TPESampler

# 把 ml-service 根目錄加到 path
sys.path.insert(0, str(Path(__file__).parent.parent))
from app.features import compute_triple_barrier_labels


# ── 資料載入 ──────────────────────────────────────────────────────────────────
def load_ohlcv_from_csv(csv_path: str) -> pd.DataFrame:
    """從 CSV 載入 OHLCV 資料（需有 date, open, high, low, close, volume, atr14 欄位）"""
    df = pd.read_csv(csv_path, parse_dates=['date'])
    df = df.sort_values('date').reset_index(drop=True)
    # 若無 ATR14，自行計算
    if 'atr14' not in df.columns:
        tr = pd.concat([
            df['high'] - df['low'],
            (df['high'] - df['close'].shift(1)).abs(),
            (df['low'] - df['close'].shift(1)).abs(),
        ], axis=1).max(axis=1)
        df['atr14'] = tr.rolling(14).mean()
    return df


def load_ohlcv_from_d1() -> pd.DataFrame:
    """從 Cloudflare D1 API 載入全部活躍股票的 OHLCV"""
    import requests

    CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '619a83ac9f20847d9e2f2920823b727d')
    CF_D1_DB_ID = os.environ.get('CF_D1_DB_ID', '6401a5f6-5767-4fa8-a1a7-ec8d4739ac79')
    CF_API_TOKEN = os.environ.get('CF_API_TOKEN', '')
    D1_API = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_D1_DB_ID}/query'

    headers = {'Authorization': f'Bearer {CF_API_TOKEN}', 'Content-Type': 'application/json'}

    # 取活躍股票清單
    resp = requests.post(D1_API, json={'sql': "SELECT id, symbol FROM stocks WHERE is_active=1"}, headers=headers)
    stocks = resp.json()['result'][0]['results']

    all_rows = []
    for stock in stocks:
        resp = requests.post(D1_API, json={
            'sql': '''SELECT sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume,
                             ti.atr14
                      FROM stock_prices sp
                      LEFT JOIN technical_indicators ti ON ti.stock_id = sp.stock_id AND ti.date = sp.date
                      WHERE sp.stock_id = ? AND sp.close IS NOT NULL
                      ORDER BY sp.date ASC''',
            'params': [stock['id']]
        }, headers=headers)
        rows = resp.json().get('result', [{}])[0].get('results', [])
        for r in rows:
            r['symbol'] = stock['symbol']
        all_rows.extend(rows)

    df = pd.DataFrame(all_rows)
    df['date'] = pd.to_datetime(df['date'])
    return df


# ── 標籤品質評估 ─────────────────────────────────────────────────────────────
def evaluate_label_quality(
    df: pd.DataFrame,
    upper_mult: float,
    lower_mult: float,
    pct_cap: float,
    max_days: int,
) -> dict:
    """
    對每支股票計算 triple barrier labels，評估標籤品質：
    - direction_accuracy：標籤 1 的未來 N 日實際漲、標籤 0 的實際跌的比例
    - coverage：非 NaN 標籤佔比（太低 = 大部分到期平倉，標籤無用）
    - balance：正負樣本均衡度（|ratio - 0.5| 越小越好）
    """
    symbols = df['symbol'].unique() if 'symbol' in df.columns else ['single']
    accuracies = []
    coverages = []
    balances = []

    for sym in symbols:
        sub = df[df['symbol'] == sym] if 'symbol' in df.columns else df
        if len(sub) < 60:
            continue

        close = sub['close'].astype(float)
        high = sub['high'].astype(float)
        low = sub['low'].astype(float)
        atr = sub['atr14'].astype(float)

        labels = compute_triple_barrier_labels(
            close, high, low, atr,
            upper_atr_mult=upper_mult,
            lower_atr_mult=lower_mult,
            upper_pct_cap=pct_cap,
            lower_pct_cap=pct_cap * 0.5,  # 停損 = 停利的一半（風報比 2:1）
            max_days=max_days,
        )

        valid = labels.dropna()
        if len(valid) < 20:
            continue

        coverage = len(valid) / len(labels)
        balance = valid.mean()  # 接近 0.5 最好

        # 方向準確率：label=1 時，N 日後漲；label=0 時，N 日後跌
        future_ret = close.shift(-max_days // 2) / close - 1
        aligned = pd.DataFrame({'label': labels, 'ret': future_ret}).dropna()
        if len(aligned) < 10:
            continue

        correct = ((aligned['label'] == 1) & (aligned['ret'] > 0)) | \
                  ((aligned['label'] == 0) & (aligned['ret'] < 0))
        accuracy = correct.mean()

        accuracies.append(accuracy)
        coverages.append(coverage)
        balances.append(abs(balance - 0.5))

    if not accuracies:
        return {'accuracy': 0.5, 'coverage': 0.0, 'balance_penalty': 0.5}

    return {
        'accuracy': float(np.mean(accuracies)),
        'coverage': float(np.mean(coverages)),
        'balance_penalty': float(np.mean(balances)),
    }


# ── Optuna 目標函數 ──────────────────────────────────────────────────────────
_train_df: pd.DataFrame = pd.DataFrame()
_test_df: pd.DataFrame = pd.DataFrame()


def objective(trial: optuna.Trial) -> float:
    upper_mult = trial.suggest_float('upper_mult', 2.0, 4.0, step=0.25)
    lower_mult = trial.suggest_float('lower_mult', 1.5, 3.0, step=0.25)
    pct_cap = trial.suggest_float('pct_cap', 0.03, 0.10, step=0.005)
    max_days = trial.suggest_int('max_days', 10, 30, step=5)

    # 在訓練集上評估
    result = evaluate_label_quality(_train_df, upper_mult, lower_mult, pct_cap, max_days)

    # 複合目標：準確率為主，覆蓋率加分，不平衡懲罰
    score = result['accuracy'] * 0.7 + result['coverage'] * 0.2 - result['balance_penalty'] * 0.1
    return score


def run_optuna(df: pd.DataFrame, n_trials: int = 100) -> dict:
    global _train_df, _test_df

    # OOS 20% 鎖定
    split_idx = int(len(df) * 0.8)
    if 'symbol' in df.columns:
        # 按時間切分（每支股票各自切 80/20）
        train_parts, test_parts = [], []
        for sym in df['symbol'].unique():
            sub = df[df['symbol'] == sym].sort_values('date')
            sp = int(len(sub) * 0.8)
            train_parts.append(sub.iloc[:sp])
            test_parts.append(sub.iloc[sp:])
        _train_df = pd.concat(train_parts).reset_index(drop=True)
        _test_df = pd.concat(test_parts).reset_index(drop=True)
    else:
        _train_df = df.iloc[:split_idx].reset_index(drop=True)
        _test_df = df.iloc[split_idx:].reset_index(drop=True)

    print(f'📊 訓練集: {len(_train_df)} rows, 測試集: {len(_test_df)} rows')

    study = optuna.create_study(
        direction='maximize',
        sampler=TPESampler(seed=42),
        study_name='triple_barrier_scan',
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=True)

    best = study.best_params
    print(f'\n🏆 最佳參數: {best}')
    print(f'   訓練集分數: {study.best_value:.4f}')

    # OOS 驗證
    oos = evaluate_label_quality(
        _test_df,
        best['upper_mult'], best['lower_mult'], best['pct_cap'], best['max_days'],
    )
    print(f'   OOS 準確率: {oos["accuracy"]:.4f}')
    print(f'   OOS 覆蓋率: {oos["coverage"]:.4f}')
    print(f'   OOS 平衡度偏差: {oos["balance_penalty"]:.4f}')

    return {
        'best_params': best,
        'train_score': study.best_value,
        'oos_metrics': oos,
        'n_trials': n_trials,
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Optuna Triple Barrier 參數搜尋')
    parser.add_argument('--csv', type=str, help='OHLCV CSV 檔案路徑')
    parser.add_argument('--d1', action='store_true', help='從 D1 載入資料')
    parser.add_argument('--trials', type=int, default=100, help='搜尋次數')
    parser.add_argument('--output', type=str, default='optuna_barrier_result.json')
    args = parser.parse_args()

    if args.csv:
        df = load_ohlcv_from_csv(args.csv)
    elif args.d1:
        df = load_ohlcv_from_d1()
    else:
        print('請指定 --csv 或 --d1')
        sys.exit(1)

    print(f'載入 {len(df)} 筆資料')
    result = run_optuna(df, n_trials=args.trials)

    with open(args.output, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False, default=str)
    print(f'\n💾 結果已儲存到 {args.output}')
