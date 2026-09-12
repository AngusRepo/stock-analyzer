"""Frozen per-arm ML inputs; market reads and trading policy remain shared.

This consumes sealed model-producer output, never creates/trains an artifact or
grants promotion. An ensemble comparison must not reuse incumbent inference for
the challenger. Existing EV-only comparisons retain their shared ML context.
"""
from copy import deepcopy
import re

from services.paired_nav_journal import digest

ARMS = ('baseline', 'candidate')
DUAL_INPUT_OWNERS = {'ensemble', 'atomic_strategy'}


def atomic_model_context(*, context, prepared, definition_checksum):
    """Bind verified daily own-slate inference; never invent an ML artifact.

    The caller first replays the original Atomic recommendation/source boundary.
    This packet has no allocation-pair, order, registration or maturity authority.
    """
    from services.paired_nav_l3_candidate import _native_predictions
    if prepared.get('input_hash') != digest({k: v for k, v in prepared.items() if k != 'input_hash'}):
        raise ValueError('paired_native_atomic_prepared_invalid')
    definition = prepared['definitions'][definition_checksum]
    lineage = definition['inference_lineage']
    formal = context['formal_baseline_identity']
    identity = {name: formal[source] for name, source in (
        ('artifact_id', 'artifact_id'), ('artifact_checksum', 'payload_checksum'), ('cohort_id', 'cohort_id'))}
    arms = {}
    for arm, predictions in (('baseline', context['model_predictions']), ('candidate', definition['predictions'])):
        predictions = deepcopy(predictions)
        selection_symbols = set(predictions)
        holding_scopes = []
        for scope in definition.get('holding_predictions', []):
            if scope['arm'] != arm:
                continue
            symbol = scope['target_symbol']
            if (symbol in predictions or scope['definition_checksum'] != definition_checksum
                    or scope['reference_key'] != lineage[arm + '_key']):
                raise ValueError('paired_native_atomic_holding_scope_mismatch')
            predictions[symbol] = deepcopy(scope['prediction'])
            holding_scopes.append(scope)
        if prepared.get('native_holdings') is not None:
            from services.paired_nav_native_holdings import validate_holding_prediction_coverage
            validate_holding_prediction_coverage(definition, definition_checksum=definition_checksum, arm=arm,
                predictions=predictions, selection_symbols=selection_symbols, source=prepared['native_holdings'])
        native = _native_predictions(predictions, identity)
        arms[arm] = {'model_identity': deepcopy(identity), 'predictions': native,
            'input_identity': {'schema_version': 'atomic-native-input-v1', 'arm': arm,
                'definition_checksum': definition_checksum, 'slate_checksum': lineage[arm + '_key'],
                'serving_manifest_digest': lineage['serving_manifest_digest'],
                'prepared_input_checksum': prepared['input_hash'], 'predictions_checksum': digest(native)}}
        if holding_scopes:
            arms[arm]['input_identity'].update(schema_version='atomic-native-input-v2',
                holding_scope_checksum=digest(holding_scopes))
    common = arms['baseline']['predictions']
    packet = {'owner': 'atomic_strategy', 'candidate_checksum': definition_checksum,
        'configuration': {'formal_baseline_identity': deepcopy(formal)},
        'model_predictions': common, 'model_predictions_checksum': digest(common),
        'model_prediction_arms': arms, 'model_prediction_arms_checksum': digest(arms),
        'production_effect': False, 'promotion_allowed': False, 'can_write_order': False,
        'nav_maturity_credit': 0}
    prediction_arms(packet)
    return packet


def model_context_fields(parent: dict, allocation: dict) -> dict:
    """Bind a pre-session allocation to its already frozen inference payload."""
    predictions = parent.get('model_predictions')
    if not isinstance(predictions, dict) or digest(predictions) != allocation.get('model_predictions_checksum'):
        raise ValueError('paired_native_frozen_model_parent_mismatch')
    fields = {'model_predictions': deepcopy(predictions), 'model_predictions_checksum': digest(predictions)}
    if 'model_prediction_arms' in parent:
        arms = parent['model_prediction_arms']
        if digest(arms) != allocation.get('model_prediction_arms_checksum'):
            raise ValueError('paired_native_model_arms_parent_mismatch')
        fields.update(model_prediction_arms=deepcopy(arms), model_prediction_arms_checksum=digest(arms))
    elif 'model_prediction_arms_checksum' in allocation:
        raise ValueError('paired_native_model_arms_parent_missing')
    prediction_arms({**allocation, **fields})
    return fields


def prediction_arms(packet: dict) -> dict[str, dict]:
    """Validate immutable identities; no missing-model or missing-arm fallback."""
    common = packet.get('model_predictions')
    if not isinstance(common, dict) or digest(common) != packet.get('model_predictions_checksum'):
        raise ValueError('native_capture_model_context_corrupt')
    dual = packet.get('model_prediction_arms')
    if dual is None:
        if packet.get('owner') in DUAL_INPUT_OWNERS or 'model_prediction_arms_checksum' in packet:
            label = 'atomic_strategy' if packet.get('owner') == 'atomic_strategy' else 'ensemble'
            raise ValueError('paired_native_' + label + '_arm_predictions_required')
        return {arm: {'predictions': deepcopy(common), 'model_identity': None} for arm in ARMS}
    if (packet.get('owner') not in DUAL_INPUT_OWNERS or not isinstance(dual, dict) or set(dual) != set(ARMS)
            or digest(dual) != packet.get('model_prediction_arms_checksum')):
        raise ValueError('paired_native_model_arms_invalid')
    for arm in ARMS:
        value = dual[arm]
        fields = {'model_identity', 'predictions'}
        atomic = packet['owner'] == 'atomic_strategy'
        if atomic:
            fields.add('input_identity')
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError('paired_native_model_arm_invalid')
        identity = value['model_identity']
        if (not isinstance(identity, dict) or set(identity) != {'artifact_id', 'artifact_checksum', 'cohort_id'}
                or any(not isinstance(v, str) or not v.strip() for v in identity.values())
                or (not atomic and identity['artifact_checksum'] != packet.get(arm + '_checksum'))
                or len(identity['artifact_checksum']) != 64
                or any(c not in '0123456789abcdef' for c in identity['artifact_checksum'])
                or not isinstance(value['predictions'], dict)):
            raise ValueError('paired_native_model_arm_identity_mismatch')
        if atomic:
            _validate_atomic_identity(packet, arm, value)
    if common != dual['baseline']['predictions']:
        raise ValueError('paired_native_incumbent_predictions_mismatch')
    return deepcopy(dual)


def _validate_atomic_identity(packet, arm, value):
    identity = value['input_identity']
    fields = {'schema_version', 'arm', 'definition_checksum', 'slate_checksum',
              'serving_manifest_digest', 'prepared_input_checksum', 'predictions_checksum'}
    schema = identity.get('schema_version') if isinstance(identity, dict) else None
    if schema == 'atomic-native-input-v2':
        fields.add('holding_scope_checksum')
    formal = packet.get('configuration', {}).get('formal_baseline_identity', {})
    expected_model = {name: formal.get(source) for name, source in (
        ('artifact_id', 'artifact_id'), ('artifact_checksum', 'payload_checksum'), ('cohort_id', 'cohort_id'))}
    if (not isinstance(identity, dict) or set(identity) != fields
            or schema not in {'atomic-native-input-v1','atomic-native-input-v2'} or identity.get('arm') != arm
            or any(not isinstance(identity.get(k), str) or re.fullmatch('[a-f0-9]{64}', identity[k]) is None
                for k in fields - {'schema_version', 'arm'})
            or identity['definition_checksum'] != packet.get('candidate_checksum')
            or identity['predictions_checksum'] != digest(value['predictions'])
            or value['model_identity'] != expected_model):
        raise ValueError('paired_native_atomic_input_identity_mismatch')
    baseline = packet['model_prediction_arms'].get('baseline')
    other = baseline.get('input_identity') if isinstance(baseline, dict) else None
    if not isinstance(other, dict):
        raise ValueError('paired_native_atomic_input_identity_mismatch')
    if any(identity.get(k) != other.get(k) for k in (
            'definition_checksum', 'serving_manifest_digest', 'prepared_input_checksum')):
        raise ValueError('paired_native_atomic_shared_context_mismatch')


def validate_prediction_carry(previous, current):
    """Daily slates/forecasts may advance, the compared model may not."""
    if current.get('owner') not in DUAL_INPUT_OWNERS and previous.get('owner') not in DUAL_INPUT_OWNERS:
        return
    if current.get('owner') != previous.get('owner'):
        raise ValueError('paired_native_carry_model_owner_changed')
    old, new = prediction_arms(previous), prediction_arms(current)
    if any(old[arm]['model_identity'] != new[arm]['model_identity'] for arm in ARMS):
        raise ValueError('paired_native_carry_model_identity_changed')
    if current['owner'] == 'atomic_strategy' and any(
            old[arm]['input_identity']['definition_checksum'] != new[arm]['input_identity']['definition_checksum']
            for arm in ARMS):
        raise ValueError('paired_native_carry_atomic_definition_changed')


class ModelScopedReader:
    """Keep artifact lineage in the durable read key, even for equal outputs."""
    def __init__(self, capability, model_identity, input_identity=None):
        self.capability = capability
        self.model_identity = deepcopy(model_identity)
        self.input_identity = deepcopy(input_identity)

    @property
    def source_identity(self):
        return {**self.capability.source_identity, 'model_identity': self.model_identity,
                **({'input_identity': self.input_identity} if self.input_identity is not None else {})}

    def read_native(self, request, frame):
        from routers.intraday import RescoreRequest
        import math
        if request.get('url') != self.capability.controller_url + '/intraday/rescore':
            raise ValueError('paired_native_model_read_not_rescore')
        parsed = RescoreRequest.model_validate_json(request['body'])
        for position in parsed.positions:
            prediction = self.capability.predictions.get(position.symbol)
            if not isinstance(prediction, dict):
                raise ValueError('paired_native_arm_prediction_missing')
            confidence = prediction.get('direction_accuracy')
            signal = prediction.get('signal_raw') or prediction.get('trade_signal')
            if (type(confidence) not in (int, float) or not math.isfinite(confidence)
                    or not 0 <= confidence <= 1 or not isinstance(signal, str) or not signal.strip()):
                raise ValueError('paired_native_arm_prediction_invalid')
        return self.capability.read_native(request, frame)


class PairedModelCapture:
    """Host-only dispatch: Node cannot choose its arm or another model.

    Only pure frozen ML rescore goes to per-arm readers. Quotes, SQL, corporate
    actions and other source reads go to the same immutable common capture.
    """
    def __init__(self, common, models: dict, rescore_url: str):
        self.common, self.models, self.rescore_url = common, models, rescore_url

    def for_arm(self, arm):
        if arm not in ARMS:
            raise ValueError('paired_native_unknown_model_arm')
        return _ArmModelCapture(self, arm)

    def read(self, operation, request, frame):
        # Unscoped use may share market data, never choose baseline for ML.
        if operation == 'frozen_fetch' and request.get('url') == self.rescore_url:
            raise ValueError('paired_native_rescore_arm_required')
        return self.common.read(operation, request, frame)


class _ArmModelCapture:
    def __init__(self, owner, arm):
        self.owner, self.arm = owner, arm

    def read(self, operation, request, frame):
        if operation == 'frozen_fetch' and request.get('url') == self.owner.rescore_url:
            return self.owner.models[self.arm].read(operation, request, frame)
        return self.owner.common.read(operation, request, frame)


def validate_model_frame(packet: dict, arm: str, frame: dict) -> None:
    """Reconcile recorded pure inference with the sealed arm before publication.

    A self-consistent transcript/state checksum alone cannot prove that the
    challenger used its own model. Recompute only the deterministic rescore;
    never acquire new prices, fit a model, or call a live endpoint during replay.
    """
    if packet.get('owner') not in DUAL_INPUT_OWNERS:
        return
    if arm not in ARMS:
        raise ValueError('paired_native_unknown_model_arm')
    model = prediction_arms(packet)[arm]
    controller = packet['variables'].get('ML_CONTROLLER_URL', '').rstrip('/')
    records = [record for record in frame.get('responses', [])
               if (record.get('request') or {}).get('url') == controller + '/intraday/rescore']
    if not records:
        return
    from services.native_paper_read_capabilities import NativeReadCapabilities
    def forbidden(*args, **kwargs):
        raise RuntimeError('paired_native_model_replay_external_read_forbidden')
    capability = NativeReadCapabilities(broker_url='', broker_token='', controller_url=controller,
        trading_config=packet['configuration']['trading_config'], predictions=model['predictions'],
        session_date=packet['session_date'], transport=forbidden, kv_read=forbidden)
    reader = ModelScopedReader(capability, model['model_identity'], model.get('input_identity'))
    for record in records:
        request = record.get('request') or {}
        identity = record.get('identity') or {}
        context = identity.get('source_context') or {}
        if (identity.get('operation') != 'frozen_fetch' or identity.get('request') != request
                or identity.get('frame_id') != frame['input_id']
                or identity.get('observed_at') != frame['observed_at']
                or context.get('model_identity') != model['model_identity']
                or context.get('input_identity') != model.get('input_identity')
                or context.get('predictions_checksum') != digest(model['predictions'])
                or context.get('trading_config_checksum') != digest(packet['configuration']['trading_config'])
                or context.get('session_date') != packet['session_date']):
            raise ValueError('paired_native_model_transcript_identity_mismatch')
        if record.get('response') != reader.read_native(request, frame):
            raise ValueError('paired_native_model_transcript_result_mismatch')
