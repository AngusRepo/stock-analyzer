"""One frozen Oct 19 Paper publication; comparison remains explicitly deferred."""
from datetime import datetime, timedelta, timezone

from services.paired_nav_journal import digest
from services.l4_distribution import digest as model_digest

SIGNAL = '2026-10-16'
TRADE = '2026-10-19'
PARENT = 'pipeline-dispatch:2026-10-16:5c19f0c8-ef02-4969-bd23-a00b8a36ee1d'
CONTEXT = '3f3e593d6ccfef26deae8b32ab346f7f2b2da8f87c3b9a78dfd0c7145c93fc34'
SEAL = 'b615a618a7c12d5a91680600f686c177dd699d9f54b07590ca3b48df9863cb70'
CONFIG = 'e2864e8bd96e79716f178ea8c58510cf0fb1179b9c7a6e8236eade7601ef5133'


def publication_deferral(state, config, *, now=None, seal_reader=None):
    """Never reinterpret an arbitrary research failure as serving success."""
    local = (now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=8)))
    context = state.get('premarket_context') or {}
    if (local.date().isoformat() != TRADE or state.get('run_date') != SIGNAL
            or state.get('producer_run_id') != PARENT
            or context.get('trade_date') != TRADE or context.get('checksum') != CONTEXT):
        return None
    if digest({k: v for k, v in context.items() if k != 'checksum'}) != CONTEXT:
        raise ValueError('dated_publication_context_changed')
    if digest(config) != CONFIG:
        raise ValueError('dated_publication_configuration_changed')
    policy = config['l4Distribution']
    mode = {'mode': policy['operating_mode'], 'strategy_role': policy['strategy_role'],
        'model_checksum': policy['artifact']['model_checksum'],
        'l3_identity': policy['artifact']['l3_identity'], 'configuration_checksum': model_digest(config)}
    if seal_reader is None:
        from services.premarket_pipeline import read_seal
        seal_reader = read_seal
    seal = seal_reader(SIGNAL, PARENT)
    if (seal.get('run_date') != SIGNAL or seal.get('run_id') != PARENT
            or seal.get('checksum') != SEAL):
        raise ValueError('dated_publication_l3_seal_changed')
    receipt = {'schema_version': 'dated-formal-publication-deferral-v1',
        'signal_date': SIGNAL, 'trade_date': TRADE, 'producer_run_id': PARENT,
        'context_checksum': CONTEXT, 'l3_receipt_checksum': SEAL,
        'configuration_checksum': CONFIG, 'paper_strategy': mode, 'scope': 'paper',
        'status': 'comparison_deferred', 'reason': 'formal_pending_buys_recovery',
        'paired_accounts_executed': 0, 'nav_maturity_credit': 0,
        'promotion_allowed': False, 'expires_at': '2026-10-20T00:00:00+08:00'}
    return {**receipt, 'receipt_checksum': digest(receipt)}
