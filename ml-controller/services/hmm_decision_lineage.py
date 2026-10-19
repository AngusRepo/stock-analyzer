"""Freeze HMM identity across recommendation, allocation and publication."""
import re
from datetime import datetime, timedelta, timezone
from .hmm_input_contract import CONTRACT_HASH


def decision_lineage(contract, signal_date, *, now=None):
    p = (contract.get('regime_evidence') or {}).get('hmm_provenance') or {}
    model = p.get('model') or {}
    result = {'modelSha256': model.get('sha256'), 'modelGeneration': str(model.get('generation') or ''),
              'inputChecksum': p.get('input_checksum'), 'qualityChecksum': p.get('risk_quality_checksum')}
    if (contract.get('run_date') != signal_date or p.get('feature_date') != signal_date
            or p.get('input_contract') != CONTRACT_HASH or model.get('input_contract') != CONTRACT_HASH
            or any(not re.fullmatch('[a-f0-9]{64}', str(result[k] or ''))
                   for k in ('modelSha256', 'inputChecksum', 'qualityChecksum'))
            or not result['modelGeneration'].isdigit()):
        raise ValueError('HMM_DECISION_LINEAGE_UNVERIFIED')
    def stamp(value):
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('HMM_DECISION_CLOCK_UNZONED')
        return parsed
    trained, inferred, computed = map(stamp, (model.get('trained_at'), p.get('inference_as_of'), contract.get('computed_at')))
    now = now or datetime.now(timezone.utc)
    if not trained <= inferred <= computed <= now or now - trained > timedelta(days=9):
        raise ValueError('HMM_DECISION_CLOCK_INVALID')
    return result
