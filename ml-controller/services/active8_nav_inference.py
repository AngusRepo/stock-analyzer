"""Original NAV adoption projected into the existing private frozen compute path.

The Controller alone captures this from its sealed D1 grant. Modal already ships
these shared services and receives the generation/hash-bound request through an
authenticated private function. Checksums detect corruption, not authenticity:
the original request owner/transport is the trust boundary. This is NOT a public
authorization endpoint and a restored inference grant cannot publish or trade.
"""
from dataclasses import dataclass
import json

from services.paired_nav_journal import digest, _timestamp


SCHEMA = 'active8-nav-frozen-inference-v1'
_INFERENCE_SEAL = object()


@dataclass(frozen=True)
class _InferenceGrant:
    artifact_checksum: str
    base_json: str
    context_checksum: str
    seal: object


def permits_inference(grant, *, artifact, pool_models):
    if not isinstance(grant, _InferenceGrant) or grant.seal is not _INFERENCE_SEAL:
        return False
    if artifact.get('payload_checksum') != grant.artifact_checksum:
        return False
    base = json.loads(grant.base_json)
    if base != artifact.get('base_artifacts'):
        return False
    return all(isinstance(pool_models.get(name), dict)
        and pool_models[name].get('serving_eligible') is True
        and pool_models[name].get('serving_artifact_id') == expected['artifact_id']
        and pool_models[name].get('version') == expected['version']
        and pool_models[name].get('checksum') == expected['checksum'] for name, expected in base.items())


def capture_frozen_nav_inference(grant, *, artifact, pool_models):
    from services.active8_nav_adoption import is_serving_grant
    if not is_serving_grant(grant) or json.loads(grant.payload_json) != artifact:
        raise ValueError('active8_nav_inference_original_grant_required')
    body = {'schema_version': SCHEMA, 'scope': 'frozen_compute_only',
        'captured_at': grant.observed_at, 'artifact_checksum': artifact['payload_checksum'],
        'publication_receipt': json.loads(grant.receipt_json),
        'review_records': json.loads(grant.review_records_json)}
    context = {**body, 'context_checksum': digest(body)}
    restore_frozen_nav_inference(context, artifact=artifact, pool_models=pool_models)
    return context


def restore_frozen_nav_inference(context, *, artifact, pool_models):
    """Only for the original frozen Controller/Modal request, never live adoption."""
    from services.ensemble_v2 import validate_active8_ensemble_candidate, ensemble_artifact_id
    from services.paired_nav_review_store import _key
    if (not isinstance(context, dict) or context.get('schema_version') != SCHEMA
            or context.get('scope') != 'frozen_compute_only'
            or digest({k: v for k, v in context.items() if k != 'context_checksum'}) != context.get('context_checksum')
            or context.get('artifact_checksum') != artifact.get('payload_checksum')):
        raise ValueError('active8_nav_frozen_context_invalid')
    validate_active8_ensemble_candidate(artifact)
    receipt = context['publication_receipt']
    nav = receipt['nav_validation']
    decision = {k: v for k, v in nav.items() if k not in ('decision_checksum', 'decision_payload_json')}
    if (receipt.get('schema_version') != 'active8-ensemble-atomic-promotion-evidence-v1'
            or receipt.get('ensemble_artifact_id') != ensemble_artifact_id(artifact)
            or receipt.get('ensemble_payload_checksum') != artifact['payload_checksum']
            or receipt.get('base_artifact_set_checksum') != digest(artifact['base_artifacts'])
            or artifact['base_artifact_set_checksum'] != digest(artifact['base_artifacts'])
            or receipt.get('selected_models') != sorted(artifact['selected_models'])
            or receipt.get('validation') != artifact['validation']
            or receipt.get('evaluation_business_date') != nav.get('as_of_date')
            or digest(receipt['nav_configuration']) != nav.get('configuration_checksum')
            or nav.get('owner') != 'ensemble' or nav.get('decision') != 'PASS'
            or nav.get('candidate_artifact_id') != receipt['ensemble_artifact_id']
            or nav.get('candidate_checksum') != artifact['payload_checksum']
            or nav.get('decision_checksum') != digest(decision)
            or json.loads(nav.get('decision_payload_json') or '{}') != decision):
        raise ValueError('active8_nav_frozen_receipt_invalid')
    records = context['review_records']
    by_kind = {record['header']['record_kind']: record for record in records}
    if len(records) != 3 or set(by_kind) != {'review','protocol','reservation'}:
        raise ValueError('active8_nav_frozen_review_set_invalid')
    for kind, record in by_kind.items():
        header, body = record['header'], record['body']
        if (header['payload_checksum'] != digest(body)
                or any(header[key] != body[key] for key in ('protocol_id','family_id','review_id','record_kind','as_of_date'))
                or header['record_id'] != _key(header['protocol_id'], header['family_id'], header['review_id'], kind)
                or header['protocol_id'] != nav['protocol_id']
                or _timestamp(header['created_at']) > _timestamp(context['captured_at'])):
            raise ValueError('active8_nav_frozen_review_source_invalid')
    review, protocol, reservation = [by_kind[k] for k in ('review','protocol','reservation')]
    body = review['body']
    findings = [h for h in body['family']['hypotheses'] if h['hypothesis_checksum'] == nav['hypothesis_checksum']]
    if (review['header']['record_id'] != nav['review_record_id']
            or review['header']['record_id'] != _key(nav['protocol_id'],nav['family_id'],nav['review_id'])
            or reservation['header']['record_id'] != _key(nav['protocol_id'],nav['family_id'],nav['review_id'],'reservation')
            or review['header']['payload_checksum'] != nav['review_record_checksum']
            or reservation['header']['payload_checksum'] != nav['reservation_checksum']
            or body['protocol_checksum'] != protocol['header']['payload_checksum']
            or body['reservation_checksum'] != reservation['header']['payload_checksum']
            or reservation['body']['protocol_checksum'] != protocol['header']['payload_checksum']
            or body['as_of_date'] != nav['checkpoint_as_of_date'] or body['as_of_date'] > nav['as_of_date']
            or len(findings) != 1 or findings[0]['numerical_support'] is not True
            or any(findings[0][key] != nav[key] for key in ('effect_pair_id','mean_daily_nav_delta','holm_adjusted_p'))
            or body['family']['review_alpha'] != nav['review_alpha']
            or reservation['body']['review_alpha'] != nav['review_alpha']):
        raise ValueError('active8_nav_frozen_review_mismatch')
    grant = _InferenceGrant(artifact['payload_checksum'], json.dumps(artifact['base_artifacts'], sort_keys=True),
        context['context_checksum'], _INFERENCE_SEAL)
    if not permits_inference(grant, artifact=artifact, pool_models=pool_models):
        raise ValueError('active8_nav_frozen_model_identity_mismatch')
    return grant
