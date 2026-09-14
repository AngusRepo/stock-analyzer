"""Synthetic release fixtures only; no research or deployment evidence."""
from services.l4_distribution import digest
from services.l4_incremental_acceptance import build_comparison, COMMON, MATCHED_L3


def comparison(candidate):
    runs={}
    for role,end in [('candidate',102.),('incumbent',101.),('l3_same_allocator',101.5)]:
        runs[role]={**dict.fromkeys(COMMON+MATCHED_L3,'a'*64), 'complete':True,
            'model_checksum':candidate['model_checksum'] if role=='candidate' else 'b'*64,
            'l3_identity_checksum':digest(candidate['l3_identity']),
            'prediction_policy':'native_l3_mean_no_correction' if role=='l3_same_allocator' else role,
            'ledger_checksum':digest({'role':role,'synthetic_test_only':True}),
            'accounting':'cash_plus_marked_holdings_after_costs','external_cash_flows':'none','initial_nav':100.,
            'daily_nav':[{'date':'2026-08-20','nav':end,'cash':end*.5,'holdings_market_value':end*.5}]}
    protocol={'scope':'paired_native_paper_execution','holdout_usage':'untouched_after_selection',
        'preselection':False,'selection_frozen_before':'2026-08-19','signal_dates':['2026-08-20'],
        'max_allowed_drawdown':.1}
    return build_comparison(runs,protocol,candidate_model_checksum=candidate['model_checksum'],
                            l3_identity_checksum=digest(candidate['l3_identity']))
