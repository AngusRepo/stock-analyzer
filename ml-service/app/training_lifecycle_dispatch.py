"""Start independent full-fit models before waiting on any primary group.

Retain the existing durable journal stage names and payloads. This helper has
no model registry, promotion, pointer or retry authority.
"""
import time


def start_lifecycle(targets, *, base_payload, sequence_records, sequence_length,
                    sequence_gcs_prefix, sequence_batch_count, sequence_device,
                    functions, journal=None):
    batch=dict(started=time.monotonic(),jobs={},results={},errors={})
    names=[str(t).strip() for t in targets if str(t).strip()]
    if len(set(names))!=len(names):raise ValueError('duplicate_lifecycle_target')
    for target in names:
        started=time.monotonic()
        try:
            if target not in functions:
                batch['results'][target]=dict(status='skipped',model=target,reason='unsupported_artifact_lifecycle_target')
                continue
            payload=base_payload(target)
            if target in ('PatchTST','iTransformer'):
                if not sequence_records:raise RuntimeError('missing_sequence_records_artifact')
                payload.update(sequence_records=sequence_records,seq_len=sequence_length(target),device=sequence_device,
                    sequence_gcs_prefix=sequence_gcs_prefix,sequence_batch_count=sequence_batch_count)
            function=functions[target]
            handle=(journal.spawn('lifecycle/'+target,function.spawn,payload) if journal is not None else function.spawn(payload))
            batch['jobs'][target]=dict(handle=handle,started=started)
        except Exception as exc:
            batch['errors'][target]=str(exc)
            batch['results'][target]=dict(status='error',model=target,error=str(exc),elapsed_s=round(time.monotonic()-started,3))
    return batch


def collect_lifecycle(batch):
    for target,job in batch['jobs'].items():
        try:
            result=job['handle'].get()
            if not isinstance(result,dict):raise ValueError('lifecycle_result_not_object')
            if result.get('error'):raise RuntimeError(str(result['error']))
            # Keep the actual child runtime if supplied; time until collection
            # also includes unrelated primary jobs and must not be called fit time.
            elapsed=round(time.monotonic()-job['started'],3)
            batch['results'][target]={**result,'elapsed_s':result.get('elapsed_s',elapsed),
                'dispatch_to_collection_s':elapsed}
        except Exception as exc:
            batch['errors'][target]=str(exc)
            batch['results'][target]=dict(status='error',model=target,error=str(exc),elapsed_s=round(time.monotonic()-job['started'],3))
    return batch['results'],batch['errors'],round(time.monotonic()-batch['started'],3)
