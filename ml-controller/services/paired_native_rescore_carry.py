"""Latest known own-model signals for native intraday rescore of held names.

The production rescore reads latest available ensemble predictions. A private
account extends that same policy only from its verified same-model carry;
these observations never become today's candidate/allocator forecasts.
"""
from copy import deepcopy
from datetime import date
import re
from services.paired_nav_journal import digest


def rescore_prediction_arms(packet):
    from services.paired_native_models import prediction_arms
    models = prediction_arms(packet)
    context = packet.get('model_rescore_context')
    if context is None:
        return models
    if (context.get('schema_version') != 'paired-native-rescore-carry-v1'
            or context.get('context_checksum') != digest({k:v for k,v in context.items() if k != 'context_checksum'})
            or context.get('daily_models_checksum') != digest(packet['model_prediction_arms'])
            or set(context.get('carried', {})) != set(models)
            or date.fromisoformat(context['signal_date']) >= date.fromisoformat(packet['session_date'])):
        raise ValueError('paired_native_rescore_carry_context_invalid')
    for arm, entries in context['carried'].items():
        for symbol, entry in entries.items():
            if (symbol in models[arm]['predictions'] or entry.get('model_identity') != models[arm]['model_identity']
                    or not isinstance(entry.get('prediction'), dict)
                    or re.fullmatch('[a-f0-9]{64}', str(entry.get('source_execution_snapshot_id'))) is None
                    or date.fromisoformat(entry['signal_date']) >= date.fromisoformat(context['signal_date'])):
                raise ValueError('paired_native_rescore_carry_source_invalid')
            models[arm]['predictions'][symbol] = deepcopy(entry['prediction'])
    return models


def build_rescore_carry(*, current, previous, held_symbols, signal_date,
                       previous_snapshot_id=None, previous_signal_date=None):
    from services.paired_native_models import prediction_arms, validate_prediction_carry
    current_models = prediction_arms(current)
    old_models = None
    if previous is not None:
        validate_prediction_carry(previous, current)
        old_models = rescore_prediction_arms(previous)
        if (re.fullmatch('[a-f0-9]{64}', str(previous_snapshot_id)) is None
                or not previous_signal_date or previous_signal_date >= signal_date):
            raise ValueError('paired_native_rescore_previous_source_invalid')
    carried = {arm: {} for arm in current_models}
    for arm, model in current_models.items():
        for symbol in sorted(set(held_symbols[arm]) - set(model['predictions'])):
            if old_models is None or symbol not in old_models[arm]['predictions']:
                raise ValueError('paired_native_rescore_held_history_missing:' + arm + ':' + symbol)
            prior = ((previous.get('model_rescore_context') or {}).get('carried') or {}).get(arm, {}).get(symbol)
            carried[arm][symbol] = {'prediction': deepcopy(old_models[arm]['predictions'][symbol]),
                'model_identity': deepcopy(model['model_identity']),
                'signal_date': prior['signal_date'] if prior else previous_signal_date,
                'source_execution_snapshot_id': previous_snapshot_id}
    body = {'schema_version':'paired-native-rescore-carry-v1', 'signal_date':signal_date,
        'daily_models_checksum':digest(current['model_prediction_arms']), 'carried':carried}
    return {**body, 'context_checksum':digest(body)}
