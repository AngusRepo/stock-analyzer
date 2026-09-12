"""Existing daily pipeline -> exact native execution registration.

Credentials stay in the authenticated host. This module never creates an
order, fits a model, grants promotion or resets existing EV maturity.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
import os
import re
from urllib.parse import urlsplit

from services.paired_nav_journal import digest, read_snapshot, _timestamp
from services.paired_native_registration import register_allocation_pair


def build_capture_source(*, snapshot_id, packet, objects, domain_queries, kv_read,
                         controller_token='', broker_token='', corporate_reader=None,
                         transport=None, clock=None, shadow_hmac_secret=''):
    from services.native_paper_source_capture import NativeSourceCapture
    from services.native_paper_read_capabilities import NativeReadCapabilities
    from services.native_paper_debate import NativeCapturedDebate, NativeGeminiRead
    from services.llm_debate_client import GEMINI_MODEL_DEFAULT
    from services.paired_native_sources import PairSourceKV
    from services.paired_native_models import prediction_arms, ModelScopedReader, PairedModelCapture
    from copy import copy
    models = prediction_arms(packet)
    context = packet['source_context']
    if context['variables'] != packet['variables']:
        raise ValueError('native_capture_worker_context_mismatch')
    raw_rounds = context['frozen_kv'].get('ml:config.debate_max_rounds')
    try:
        rounds = max(1, min(3, int(str(raw_rounds).strip())))
    except ValueError:
        rounds = 2  # Identical to the original controller's missing/invalid policy.
    capture = NativeSourceCapture(objects=objects, domain_queries=domain_queries,
        inference_reads={'native_debate_llm': NativeGeminiRead()}, clock=clock)
    debate = NativeCapturedDebate(source_capture=capture, max_rounds=rounds,
        session_date=packet['session_date'], model_name=GEMINI_MODEL_DEFAULT)
    variables = packet['variables']
    if str(variables.get('LIVE_EXECUTION_SHADOW_GUARD_ENABLED', '')).lower() in {'1', 'true', 'yes', 'enabled', 'on'}:
        raise ValueError('native_external_broker_guard_cannot_govern_private_account')
    capabilities = NativeReadCapabilities(broker_url=variables.get('SHIOAJI_PROXY_URL', ''),
        broker_token=broker_token, controller_url=variables.get('ML_CONTROLLER_URL', ''),
        controller_token=controller_token, research_url=variables.get('S12_RESEARCH_KBARS_URL', ''),
        shadow_hmac_secret=shadow_hmac_secret, shadow_scope=variables.get('LIVE_EXECUTION_SHADOW_SCOPE', ''),
        trading_config=packet['configuration']['trading_config'], predictions=packet['model_predictions'],
        session_date=packet['session_date'], debate_reader=debate, transport=transport,
        kv_read=PairSourceKV(snapshot_id=snapshot_id, packet=packet, objects=objects, kv_read=kv_read,
            corporate_reader=corporate_reader, clock=clock))
    capture.inference_reads.update(capabilities.registered())
    if 'model_prediction_arms' in packet:
        captures = {}
        for arm, model in models.items():
            scoped = copy(capabilities)
            scoped.predictions = model['predictions']
            captures[arm] = NativeSourceCapture(objects=objects, domain_queries=domain_queries,
                inference_reads={'frozen_fetch': ModelScopedReader(scoped, model['model_identity'],
                    model.get('input_identity'))}, clock=clock)
        return PairedModelCapture(capture, captures, capabilities.controller_url + '/intraday/rescore')
    return capture


def collect_due_execution_frames(*, session_date, query, writer, objects,
                                 capture_factory, runner=None, clock=None):
    """Retry sealed frames, then close AND account each completed native pair.

    A missing expired frame is an explicit failure, never a backfilled day.
    All due pairs are attempted; one failed pair cannot starve the other pairs.
    The original journal materializer owns accounting. Its nightly invocation
    remains reconciliation/recovery, not a dependency on OOF model evaluation.
    """
    from services.paired_nav_journal import materialize_pair
    from services.paired_native_session import validate_schedule
    from services.paired_native_collector import collect_frame, close_collected_session, frame_identity
    from services.paired_native_sources import build_source_receipt
    clock = clock or (lambda: datetime.now(timezone.utc))
    now = clock()
    if now.astimezone(timezone(timedelta(hours=8))).date().isoformat() != session_date:
        raise ValueError('native_tick_current_session_required')
    # A signal is frozen on the previous trading day, which may precede a
    # weekend or holiday. Filter the payload's actual session, not signal+1.
    rows = query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 "
                 "WHERE snapshot_kind='execution_pair' AND signal_date<? AND signal_date>=? ORDER BY snapshot_id",
                 [session_date, (now.date() - timedelta(days=16)).isoformat()])
    results = []
    for row in rows:
        snapshot_id = row['snapshot_id']
        completed, receipt_id, journal = 0, None, None
        try:
            packet = read_snapshot(query, snapshot_id)['payload']['content']
            if packet['session_date'] != session_date:
                continue
            validate_schedule(packet['schedule'], session_date)
            # Deliveries form a contiguous prefix: collect_frame requires the
            # predecessor before publication. Binary search avoids rereading
            # every past frame on every minute (quadratic object-store I/O).
            low, high = 0, len(packet['schedule'])
            while low < high:
                middle = (low + high) // 2
                old = objects.lookup_delivery(digest(frame_identity(snapshot_id, packet['schedule'][middle])))
                if old is None:
                    high = middle
                else:
                    low = middle + 1
            completed, capture = low, None
            if completed and _timestamp(packet['schedule'][completed - 1]['observed_at']) > clock():
                raise ValueError('paired_native_future_frame_receipt')
            for index in range(completed, len(packet['schedule'])):
                frame = packet['schedule'][index]
                if _timestamp(frame['observed_at']) > clock():
                    break
                old = objects.lookup_delivery(digest(frame_identity(snapshot_id, frame)))
                if old is None:
                    if capture is None:
                        capture = capture_factory(snapshot_id=snapshot_id, packet=packet)
                    collect_frame(snapshot_id=snapshot_id, frame_index=index, objects=objects,
                        query=query, capture_source=capture, runner=runner, now=clock())
                completed += 1
            if completed == len(packet['schedule']):
                receipt_id = digest(['execution_receipt', session_date, snapshot_id])
                existing = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [receipt_id])
                if existing:
                    read_snapshot(query, receipt_id)  # checksum verification, not existence-only PASS
                else:
                    source = build_source_receipt(snapshot_id=snapshot_id, objects=objects, query=query, now=clock())
                    result = close_collected_session(snapshot_id=snapshot_id, objects=objects, query=query,
                        writer=writer, source_receipt=source, runner=runner, now=clock())
                    receipt_id = result['receipt_snapshot_id']
                # Replay/checksum/readback remain in the SAME journal owner.
                # Retry even an existing journal through that owner; existence
                # alone cannot attest correct accounting or predecessor state.
                execution = read_snapshot(query, receipt_id)['payload']['content']
                journal = materialize_pair(snapshot_id=snapshot_id, session_date=session_date,
                    execution=execution, query=query, writer=writer, now=clock())
            results.append({'snapshot_id': snapshot_id, 'status': 'closed' if journal is not None else 'collecting',
                'completed_frames': completed, 'total_frames': len(packet['schedule']), 'receipt_snapshot_id': receipt_id,
                'accounting_status': 'materialized' if journal is not None else 'awaiting_execution_receipt',
                'journal_checksum': digest(journal) if journal is not None else None})
        except Exception as exc:
            # Exceptions may carry provider URLs, bodies or credentials. Keep
            # only the exception type here; source receipts retain safe evidence.
            results.append({'snapshot_id': snapshot_id, 'status': 'failed', 'completed_frames': completed,
                'receipt_snapshot_id': receipt_id,
                'accounting_status': 'unconfirmed' if receipt_id else 'awaiting_execution_receipt',
                'error_type': type(exc).__name__, 'reason': str(exc) if re.fullmatch(
                    r'(?:native_|paired_native_|paired_nav_|corporate_|paper_corporate_)[a-z0-9_]+', str(exc))
                    else 'native_tick_source_or_execution_failed'})
    return {'status': 'failed' if any(r['status'] == 'failed' for r in results) else 'ok',
        'session_date': session_date, 'pairs': results, 'production_effect': False,
        'promotion_allowed': False, 'ev_prediction_dates_added': 0}


def run_native_execution_tick(*, session_date):
    """Deployment caller. Only private objects and Learning evidence are written."""
    from services.paper_corporate_source import production_objects
    from services.d1_domain_client import D1DataDomain, client_for_domain
    from services.kv_client import get
    objects = production_objects()
    clients = {domain.value: client_for_domain(domain) for domain in D1DataDomain}
    learning = clients['learning']
    def factory(*, snapshot_id, packet):
        return build_capture_source(snapshot_id=snapshot_id, packet=packet, objects=objects,
            domain_queries={domain: client.query for domain, client in clients.items()},
            kv_read=lambda key: get(key, strict=True),
            controller_token=os.environ.get('ML_CONTROLLER_SECRET', ''),
            shadow_hmac_secret=os.environ.get('LIVE_EXECUTION_HMAC_SECRET', ''),
            broker_token=os.environ.get('PROXY_SERVICE_TOKEN') or os.environ.get('SHIOAJI_PROXY_TOKEN', ''))
    return collect_due_execution_frames(session_date=session_date, query=learning.query,
        writer=learning.batch_execute, objects=objects, capture_factory=factory)

KV_READ_POLICY = {
    'source': ['market:', 'market_regime_state', 'ml:regime', 'holiday:', 'us:',
               'intraday:price:', 'postclose:price:'],
    'private': ['paper:', 'intraday:warn:', 'intraday:rescore:', 'intraday:rescore-cooldown:', 'risk:', 'breeze2:',
                'trading:', 'ml:config', 'ml:adaptive_params'],
}


def read_worker_context(*, transport=None, clock=None):
    import httpx
    endpoint = os.environ.get('STOCKVISION_WORKER_URL', '').strip().rstrip('/')
    token = os.environ.get('STOCKVISION_AUTH_TOKEN', '').strip()
    parsed = urlsplit(endpoint)
    if (parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not token):
        raise ValueError('native_worker_context_source_unconfigured')
    clock = clock or (lambda: datetime.now(timezone.utc))
    started = clock()
    try:
        response = (transport or httpx.post)(endpoint + '/api/internal/paper-native/context',
            headers={'Authorization': 'Bearer ' + token}, timeout=30, follow_redirects=False)
    except httpx.RequestError:
        raise RuntimeError('native_worker_context_transport_failed') from None
    if response.status_code != 200:
        raise RuntimeError('native_worker_context_http_failed:' + str(response.status_code))
    context = response.json()
    observed = _timestamp(context['observed_at'])
    if (context.get('schema_version') != 'native-paper-source-context-v1'
            or not started - timedelta(seconds=5) <= observed <= clock() + timedelta(seconds=5)
            or not isinstance(context.get('variables'), dict)
            or not isinstance(context.get('frozen_kv'), dict)):
        raise ValueError('native_worker_context_identity_invalid')
    if token in response.text:
        raise ValueError('native_worker_context_credentials_exposed')
    return context


def register_candidate_execution_plans(*, collection: dict, query, writer, objects=None,
                                     domain_queries=None, kv_read=None, context_reader=None,
                                     runner=None, clock=None) -> dict:
    plans = collection.get('plans', [])
    if not plans:
        return {'status': 'no_allocation_pairs', 'registrations': [], 'production_effect': False}
    clock = clock or (lambda: datetime.now(timezone.utc))
    pending, registered, registration_order = [], [], {}
    for plan in plans:
        allocation = read_snapshot(query, plan['snapshot_id'])
        manifest, packet = allocation['manifest'], allocation['payload']['content']
        if (manifest['snapshot_kind'] != 'allocation_pair' or manifest['prospective'] != 1
                or packet['pair_id'] != plan['pair_id'] or packet['owner'] != plan['owner']):
            raise ValueError('native_registration_plan_identity_invalid')
        identity = digest(['execution_pair', manifest['signal_date'], packet['pair_id']])
        registration_order[identity] = len(registration_order)
        if query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [identity]):
            old = read_snapshot(query, identity)
            if old['payload']['content']['allocation_snapshot_id'] != plan['snapshot_id']:
                raise ValueError('native_registration_parent_changed')
            registered.append(old['manifest'])
        else:
            pending.append(plan)
    if pending:
        if objects is None:
            from services.paper_corporate_source import production_objects
            objects = production_objects()
        if domain_queries is None:
            from services.d1_domain_client import D1DataDomain, client_for_domain
            domain_queries = {domain.value: client_for_domain(domain).query for domain in D1DataDomain}
        if kv_read is None:
            from services.kv_client import get
            kv_read = lambda key: get(key, strict=True)
        legacy_context = None
        for plan in pending:
            allocation = read_snapshot(query, plan['snapshot_id'])['payload']['content']
            parent = read_snapshot(query, allocation['allocation_context_snapshot_id'])
            parent_content = parent['payload']['content']
            if 'native_execution_environment' in parent_content:
                from services.paired_nav_execution_environment import configuration_environment
                configuration_environment(parent)
                environment = parent_content['native_execution_environment']
                context = environment['source_context']
            else:
                if legacy_context is None:
                    legacy_context = (context_reader or read_worker_context)()
                context = legacy_context
            variables = context['variables']
            # The frozen context is the sole source for new registrations.
            # Legacy plans retain their original path; never rewrite their seal.
            for flag in ('LIVE_EXECUTION_CLIENT_ENABLED', 'LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
                if str(variables.get(flag, '')).lower() in {'1', 'true', 'yes', 'enabled', 'on'}:
                    raise ValueError('native_registration_live_submission_enabled')
            registered.append(register_allocation_pair(snapshot_id=plan['snapshot_id'], query=query, writer=writer,
                domain_queries=domain_queries, kv_read=kv_read, objects=objects, account_id=1,
                variables=variables, kv_read_policy=KV_READ_POLICY, runner=runner, now=clock(), source_context=context))
    # A resumed batch may discover existing registrations before pending ones.
    # Keep the original plan order on both paths so receipts are retry-stable.
    registered.sort(key=lambda item: registration_order[item['snapshot_id']])
    return {'status': 'native_execution_pairs_registered', 'registrations': registered,
        'production_effect': False, 'nav_maturity_credit': 0, 'promotion_allowed': False}
