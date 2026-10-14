"""Synthetic accounting parity against actual Worker math; no financial evidence."""
import json
from pathlib import Path
import subprocess
import pytest
from services.paired_nav_journal import replay_session


def test_modern_journal_matches_real_native_board_odd_and_mixed_legs():
    script = """const esbuild=require('esbuild');
const js=esbuild.buildSync({stdin:{contents:`import {calcCommission,calcTax} from './src/lib/paperTradeMath';
import {buildChampionTradingConfig} from './src/lib/tradingConfig';
const values=[];for(const shares of [1,99,999,1000,1001,2001]) for(const price of [.73,5.75,100.5,2200.01])
for(const minCommission of [0,20]) { const cfg=buildChampionTradingConfig(null);cfg.fees.minCommission=minCommission;
values.push({shares,price,fees:cfg.fees,commission:calcCommission(shares*price,cfg,shares),tax:calcTax(shares*price,cfg)});}
console.log(JSON.stringify(values));`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
eval(js.outputFiles[0].text);"""
    result = subprocess.run(['node', '-e', script], cwd=Path(__file__).parents[2]/'worker',
        capture_output=True, text=True, check=True)
    cases = json.loads(result.stdout)
    assert len(cases) == 48
    for row in cases:
        fill = dict(fill_id='synthetic-sale', symbol='TEST', side='sell', shares=row['shares'], price=row['price'],
            executed_at='2026-09-08T01:00:00Z', commission=row['commission'], tax=row['tax'], is_day_trade=False)
        ledger = replay_session(previous={'cash':1000000, 'positions':{'TEST':row['shares']},
                'marks':{'TEST':row['price']}, 'nav':1000000+row['shares']*row['price']},
            fills=[fill], marks={}, corporate_actions=[], session_date='2026-09-08', fees=row['fees'],
            commission_contract='tw-equity-per-leg-floor-v1')
        assert ledger['costs'] == row['commission']+row['tax']
        assert ledger['positions'] == {}


def test_old_fee_receipt_is_not_reinterpreted_as_modern_contract():
    previous={'cash':100000, 'positions':{'TEST':100}, 'marks':{'TEST':100}, 'nav':110000}
    fees={'commission':.001425, 'minCommission':20, 'tax':.003}
    fill=dict(fill_id='synthetic-sale', symbol='TEST', side='sell', shares=100, price=100,
        executed_at='2026-09-08T01:00:00Z', commission=20, tax=30, is_day_trade=False)
    args=dict(previous=previous, fills=[fill], marks={}, corporate_actions=[], session_date='2026-09-08', fees=fees)
    assert replay_session(**args)['costs'] == 50
    with pytest.raises(ValueError, match='execution_cost_mismatch'):
        replay_session(**args, commission_contract='tw-equity-per-leg-floor-v1')
    with pytest.raises(ValueError, match='commission_contract_unknown'):
        replay_session(**args, commission_contract='unknown')
