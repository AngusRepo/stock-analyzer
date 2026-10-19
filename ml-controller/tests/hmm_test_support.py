"""Synthetic HMM contract for isolated recommendation fixtures; no model fitting."""
from datetime import datetime, timedelta, timezone
from services.hmm_input_contract import CONTRACT_HASH


def certified_contract(signal_date, **values):
    now = datetime.now(timezone.utc)
    return {'run_date': signal_date, 'computed_at': now.isoformat(),
        'regime_evidence': {'hmm_provenance': {'feature_date': signal_date,
            'input_contract': CONTRACT_HASH, 'input_checksum': 'b'*64,
            'risk_quality_checksum': 'c'*64, 'inference_as_of': now.isoformat(),
            'model': {'sha256': 'a'*64, 'generation': '1', 'input_contract': CONTRACT_HASH,
                      'trained_at': (now-timedelta(days=1)).isoformat()}}}, **values}
