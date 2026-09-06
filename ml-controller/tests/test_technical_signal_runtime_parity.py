"""Real Worker/Python scoring parity; never replaced by Python-only checks."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import numpy as np
import polars as pl

from services.backtest_engine import ScreenerParams, score_multi_factor, score_multi_factor_np
from services.technical_signal_math import macd_histogram_last

ROOT = Path(__file__).resolve().parents[2]


def fixtures():
    rng = np.random.default_rng(20260905)
    result = []
    for n in [20,34,35,40,53,70,120]:
        for pattern in range(4):
            closes = 100*np.exp(np.cumsum(rng.normal(.001*(pattern-1),.015,n)))
            if pattern == 0:
                closes = np.full(n,100.0)
            result.append({'n':n,'close':closes,'open':closes*.999,
                           'high':closes*1.015,'low':closes*.985,'volume':rng.uniform(1000,5000,n)})
    for prefix in [100.0,5000.0]:
        closes = np.linspace(80,100,70)
        result.append({'n':70,'close':closes,'open':closes*.999,'high':closes*1.015,
                       'low':closes*.985,'volume':np.array([prefix]*50+[1000.0]*20)})
    return result


def test_actual_worker_python_and_indicator_parity():
    inputs = fixtures()
    tsx = next((p for p in [ROOT/'worker/node_modules/tsx/dist/cli.mjs',
                           ROOT.parent/'worker/node_modules/tsx/dist/cli.mjs'] if p.is_file()),None)
    assert tsx is not None, 'Install Worker test dependencies to run real cross-runtime parity'
    node = os.environ.get('TEST_NODE') or shutil.which('node')
    assert node, 'Node required for actual Worker parity'
    payload = []
    for f in inputs:
        payload.append({'prices':[{'date':f'2026-01-{i:03}','stock_id':'TEST','close':float(f['close'][i]),
            'open':float(f['open'][i]),'max':float(f['high'][i]),'min':float(f['low'][i]),
            'Trading_Volume':float(f['volume'][i]),'Trading_money':float(f['volume'][i]*f['close'][i])}
            for i in range(f['n'])]})
    env = dict(os.environ, NODE_PATH=str(tsx.parents[2]))
    run = subprocess.run([node,str(tsx),str(ROOT/'worker/tests/technicalSignalParity.runner.ts')],
        input=json.dumps(payload),text=True,encoding='utf-8',capture_output=True,env=env,timeout=60,check=True)
    results = json.loads(run.stdout)
    assert len(results) == len(inputs)
    for f,worker in zip(inputs,results,strict=True):
        frame = pl.DataFrame({k:v for k,v in f.items() if k!='n'})
        numpy_scores = score_multi_factor_np(f,None,0,ScreenerParams())[:4]
        frame_scores = score_multi_factor(frame,pl.DataFrame(),0,ScreenerParams())[:4]
        np.testing.assert_allclose(numpy_scores,frame_scores,atol=1e-9)
        # Python returns the raw seed sum; Worker base_score is the later ScoreV2
        # aggregate. Compare the three identically defined seed components, not
        # two differently scaled totals; this is not full selection-policy parity.
        np.testing.assert_allclose(numpy_scores[1:],worker['scores'][1:],atol=1e-8)
        np.testing.assert_allclose(numpy_scores[0],sum(numpy_scores[1:]),atol=1e-10)
        py_macd = macd_histogram_last(f['close'])
        if py_macd is None:
            assert worker['macd'] is worker['indicator'] is None
        else:
            np.testing.assert_allclose(py_macd,worker['macd'],atol=1e-12)
            np.testing.assert_allclose(py_macd,worker['indicator'],atol=1e-12)
    # Only earlier volume differs. The actual momentum score must not change.
    assert results[-1]['scores'][3] == results[-2]['scores'][3]
