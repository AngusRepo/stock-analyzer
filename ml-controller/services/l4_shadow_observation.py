"""Registry observation caller: preflight all frozen sources, then resume owners.

No active model/config fallback, new training, registration or serving switch.
Completion is only an input prerequisite; assembly/daily remain separate jobs.
"""
from pathlib import Path
from datetime import datetime, timezone
import json

from services.l4_shadow_producer import read_reference
from services.l4_shadow_daily import configuration_checksum
from services.l4_forward_materialization import digest, timestamp


def _reason(exc):
    value = str(exc)
    return value if (value.startswith(('shadow_', 'l4_', 'payload_', 'pipeline_'))
                    and value.replace('_', '').isalnum()) else 'shadow_observation_source_invalid'


async def observe_directory(registry, directory, *, session_date, now, spawn=None, poll=None,
                            source_index_reference=None, clock=None):
    from services import l4_native_observation as native
    from services.l4_native_day_source import load_day_source, prepare_day_source, validate_resume

    clock = clock or (lambda: datetime.now(timezone.utc))
    current, _ = registry.current()
    root = Path(directory)
    if not current or not current.get('entries') or not root.is_dir():
        raise ValueError('shadow_observation_inventory_invalid')
    files = {p.stem: p for p in root.glob('*.json') if p.is_file()}
    if set(files) != set(current['entries']):
        raise ValueError('shadow_observation_inventory_invalid')
    specs = {key: json.loads(path.read_bytes()) for key, path in files.items()}
    if source_index_reference is not None:
        from services.l4_shadow_source_capture import apply_source_index
        specs = apply_source_index(registry.bucket, source_index_reference,
            current=current, session_date=session_date, specs=specs)
    plans, failures, deadlines, bindings = {}, {}, {}, {}
    for key, entry in current['entries'].items():
        try:
            registry._validate_entry(entry, incumbent=key == current['champion_id'])
            spec = specs[key]
            if (spec.get('entry_checksum') != entry['checksum']
                    or 'state_reference' in spec or 'completed_observation' in spec):
                raise ValueError('shadow_observation_entry_binding')
            config = read_reference(registry.bucket, spec['native_config_reference'])
            day_inputs = read_reference(registry.bucket, spec['day_inputs_reference'])
            day = day_inputs['signal_date']
            if (day_inputs.get('session_date') != session_date or day >= session_date
                    or timestamp(spec['observed_at']) > now):
                raise ValueError('shadow_observation_day_or_clock')
            policy = day_inputs['l4_allocation_inputs']['alpha_policy']['l4Distribution']
            identity = policy['artifact']['l3_identity']
            if (identity != config.get('l3_identity')
                    or identity['payload_checksum'] != entry['components']['L3']
                    or policy['artifact']['model_checksum'] != entry['components']['L4']
                    or day_inputs['trading_config']['l4Distribution'] != policy
                    or configuration_checksum(day_inputs['trading_config'], day_inputs['risk_config'])
                    != entry['components']['allocator_policy']):
                raise ValueError('shadow_observation_frozen_chain_mismatch')
            context = read_reference(registry.bucket, config['serving_context'])
            cutoffs = read_reference(registry.bucket, config['training_cutoffs'])
            records = {row['model']: read_reference(registry.bucket, row['reference'])
                       for row in cutoffs.get('source_references', [])}
            native.validate_context(context, identity, cutoffs, day, records)
            source_ref = spec['frozen_day_source_reference']
            resuming = validate_resume(registry.bucket, config=config, day=day, source_reference=source_ref)
            source, _, _, _, knowledge = load_day_source(registry.bucket, source_ref, day=day, now=now)
            if (configuration_checksum(source['state']['trading_config'], day_inputs['risk_config'])
                    != entry['components']['allocator_policy']
                    or timestamp(knowledge['known_at']) > timestamp(spec['observed_at'])
                    or timestamp(knowledge['known_at']) >= timestamp(day_inputs['next_open'])):
                raise ValueError('shadow_observation_day_source_policy_or_clock')
            native_key = digest(dict(day=day, identity=identity, policy=config))
            prior = bindings.get(native_key)
            if prior is not None and prior['source_reference'] != source_ref:
                raise ValueError('shadow_observation_native_key_source_conflict')
            # Reuse the owner's saved request: sequence capture time and compute
            # profile are part of the original request, not rebuilt on a retry.
            prepared = None
            if not resuming and now < timestamp(day_inputs['next_open']):
                prepared = prior['prepared'] if prior is not None else await prepare_day_source(
                    bucket=registry.bucket, reference=source_ref,
                    config=config, context=context, day=day, now=now)
            bindings[native_key] = dict(source_reference=source_ref, prepared=prepared)
            plans[key] = dict(config=config, day=day, frozen_day_source_reference=source_ref,
                              prepared_day_source=prepared)
            deadlines[key] = timestamp(day_inputs['next_open'])
        except (ValueError, KeyError, TypeError) as exc:
            failures[key] = _reason(exc)
    if failures:
        return dict(status='not_ready', session_date=session_date, entries=failures,
                    dispatched=False, production_effect=False, outer_acceptance_credit=0)
    latest, _ = registry.current()
    if latest != current:
        raise ValueError('shadow_observation_registry_changed')
    def would_spawn(plan):
        native_key = digest(dict(day=plan['day'], identity=plan['config']['l3_identity'],
                                 policy=plan['config']))
        return (not registry.bucket.blob(native.PREFIX + 'index/' + native_key + '.json').exists()
                and not registry.bucket.blob(native.PREFIX + 'dispatch/' + native_key + '/receipt.json').exists())
    # Preparing all requests can cross open. Check actual time, not the job's
    # initial timestamp, before the first irreversible spawn/claim.
    observed = clock()
    late = {key: 'shadow_observation_initial_dispatch_not_preopen' for key, plan in plans.items()
            if would_spawn(plan) and observed >= deadlines[key]}
    results, spawned = {}, []
    for key, plan in plans.items():
        # Never advance remaining entries after a concurrent registry change.
        if registry.current()[0] != current:
            raise ValueError('shadow_observation_registry_changed')
        if key in late or (would_spawn(plan) and clock() >= deadlines[key]):
            results[key] = dict(status='not_ready', reason='shadow_observation_initial_dispatch_not_preopen')
            # A different entry may already have a valid call. Pure deadline
            # failures prevent new work but must not strand that existing call.
            continue
        async def preopen_spawn(request, deadline=deadlines[key]):
            # collect can perform more I/O after the outer check. Keep the
            # actual spawn guarded too; a claim already written is retained
            # under the existing explicit recovery contract, never deleted.
            if clock() >= deadline:
                raise ValueError('shadow_observation_initial_dispatch_not_preopen')
            from services.l4_native_dispatch import modal_spawn
            result = await (spawn or modal_spawn)(request)
            spawned.append(key)
            return result
        try:
            results[key] = await native.collect(bucket=registry.bucket, **plan,
                                               spawn=preopen_spawn, poll=poll)
        except ValueError as exc:
            if str(exc) != 'shadow_observation_initial_dispatch_not_preopen':
                raise
            results[key] = dict(status='not_ready', reason=str(exc))
    complete = all(row.get('status') == 'captured' for row in results.values())
    blocked = any(row.get('status') == 'not_ready' for row in results.values())
    pending = any(row.get('status') == 'pending' for row in results.values())
    completed_at = clock()
    preopen = all(completed_at < deadline for deadline in deadlines.values())
    result = dict(status='not_ready' if blocked else ('observations_complete' if complete else 'pending'),
        session_date=session_date, registry_checksum=current['checksum'], entries=results,
        next_operation='assemble' if complete and preopen else ('observation' if pending else None),
        preopen_assembly_available=preopen,
        existing_calls_pending=pending,
        observed_at=completed_at.isoformat(),
        dispatched=bool(spawned), daily_ready_published=False,
        production_effect=False, outer_acceptance_credit=0)
    if blocked:
        result['reason'] = 'shadow_observation_session_dispatch_expired'
    return result
