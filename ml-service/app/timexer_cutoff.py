"""Separate immutable archive vintage from the samples admitted to an OOF fit."""
from datetime import date
from .pit_contract import vintage_scope

def input_scope(manifest, payload):
    signal = payload.get('signal_date_max')
    known = payload.get('label_known_at_max')
    cutoff = payload['run_date']
    date.fromisoformat(cutoff)
    if signal is None and known is None:
        if manifest.get('source_feature_date_max', '') > cutoff:
            raise ValueError('timexer_training_manifest_invalid')
        return None
    if not isinstance(signal, str) or not isinstance(known, str):
        raise ValueError('timexer_dual_cutoff_incomplete')
    date.fromisoformat(signal); date.fromisoformat(known)
    if payload.get("candidate_type") == "oof_full_fit_release":
        from .full_fit_scope import bounds
        scope = bounds(payload)
        return {**scope, "archive_source_feature_date_max": manifest.get("source_feature_date_max")}
    if (payload.get('generation_mode') != 'purged_oof'
            or payload.get('candidate_type') == 'oof_full_fit_release'
            or not signal < known or known != cutoff
            or not payload['train_start'] <= payload['train_end'] < payload['test_start'] <= payload['test_end'] <= signal):
        raise ValueError('timexer_dual_cutoff_invalid')
    return {'signal_date_max': signal, 'label_known_at_max': known,
            'archive_source_feature_date_max': manifest.get('source_feature_date_max'),
            'scope': 'explicit_purged_oof_samples', **vintage_scope(payload)}

def admitted(signal_date, label_known_date, scope):
    if scope is None:
        return True
    return signal_date <= scope['signal_date_max'] and label_known_date <= scope['label_known_at_max']
