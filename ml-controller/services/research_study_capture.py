"""Explicit Optuna boundary: record every terminal state, including interruption."""
from datetime import datetime, timezone
import hashlib
import inspect
import os
from pathlib import Path
import uuid
from services.research_trial_ledger import observation, append, optuna_trial


def recorded_optimize(study, objective, *, ledger_context=None, **kwargs):
    # Local experiments/tests have no domain binding; production has a specific
    # Research binding. Never fall back to the legacy or trading databases.
    enabled=bool(os.environ.get('CF_D1_RESEARCH_DB_ID'))
    if not enabled:
        return study.optimize(objective, **kwargs)
    from services.d1_domain_client import DomainD1Client, D1DataDomain
    client=DomainD1Client(D1DataDomain.RESEARCH,require_specific=True)
    context=ledger_context or {}
    caller=Path(inspect.currentframe().f_back.f_code.co_filename)
    run_key='optuna:'+study.study_name+':'+uuid.uuid4().hex
    study.set_user_attr('research_ledger_run_key', run_key)
    source={'pointer':'runtime://'+run_key,'sha256':hashlib.sha256(caller.read_bytes()).hexdigest()}
    requested=kwargs.get('n_trials')
    previous_numbers={t.number for t in study.trials}
    def record(kind,logical_id,content):
        return append(observation(kind,run_key=run_key,logical_id=logical_id,source=source,content=content),
                      query=client.query,writer=client.batch_execute)
    record('run','started',{'state':'running','coverage':'partial','requested_trials':requested,
        'context':context,'source_file':caller.name,'started_at':datetime.now(timezone.utc).isoformat()})
    captured=set()
    def capture(_,trial):
        trial_context=context if trial.number not in previous_numbers else {**context,
            'gaps':[*context.get('gaps',[]),'preexisting_study_trial_context_unverified']}
        row=optuna_trial(trial,run_key=run_key,source=source,context=trial_context)
        if trial.user_attrs.get('replay_error'):
            row=observation('trial',run_key=run_key,logical_id=f'trial-{trial.number}',source=source,
                content={**row['payload']['content'],'state':'fail','reason':trial.user_attrs['replay_error']})
        if row['receipt_id'] not in captured:
            append(row,query=client.query,writer=client.batch_execute)
            captured.add(row['receipt_id'])
    callbacks=[*kwargs.pop('callbacks',[]),capture]
    finished=False
    try:
        result=study.optimize(objective,callbacks=callbacks,**kwargs)
        finished=True
        return result
    finally:
        # Capture trials even if an objective or callback aborts optimization.
        # Idempotent receipts make replaying successful callbacks harmless.
        for trial in study.trials:
            if trial.state.is_finished():capture(study,trial)
        terminal=[trial for trial in study.trials if trial.state.is_finished()]
        full=finished and not previous_numbers and isinstance(requested,int) and len(terminal)==requested
        record('run','finished',{'state':'completed' if finished else 'interrupted',
            'coverage':'sealed_complete' if full else 'partial','requested_trials':requested,
            'trial_ids':sorted(f'trial-{t.number}' for t in terminal),'context':context,
            'finished_at':datetime.now(timezone.utc).isoformat()})
