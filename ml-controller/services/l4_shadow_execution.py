"""Advance registered shadow accounts through the existing native session schedule.

Only previously prepared daily inputs are accepted. No registration, model
switch, historical source backfill, account reset or statistical credit occurs.
"""
from datetime import datetime, timezone, timedelta
from services.l4_challenger_comparison import digest, instant
from services.l4_shadow_accounts import STAGES
from services.native_paper_time import frame_capture_deadline
from services.paired_native_session import session_schedule, STRATEGY_SESSION_POLICY

TW=timezone(timedelta(hours=8))

def collect_due(*, accounts, session_date, capture_factory, clock=None):
    clock=clock or (lambda:datetime.now(timezone.utc))
    now=clock()
    if now.astimezone(TW).date().isoformat()!=session_date:
        raise ValueError('shadow_tick_current_session_required')
    registry,_=accounts.registry.current()
    if registry is None:
        return dict(status='awaiting_registry',accounts=[],production_effect=False,outer_acceptance_credit=0)
    outcomes=[]
    for entry_id,entry in registry['entries'].items():
        completed=0
        try:
            head,_=accounts.current(entry_id)
            if not head or (head.get('daily_inputs') or {}).get('session_date')!=session_date:
                outcomes.append(dict(entry_id=entry_id,status='awaiting_daily_inputs'));continue
            account=registry['shadow_accounts'][entry_id];daily=head['daily_inputs']
            receipt,_=accounts._read(account+'/daily/'+session_date+'/'+daily['packet_checksum']+'.json')
            if not receipt or receipt['checksum']!=daily['receipt_checksum']:
                raise ValueError('shadow_daily_receipt_mismatch')
            packet=receipt['packet'];context=packet.get('execution_context')
            if (not context or context.get('session_policy')!=STRATEGY_SESSION_POLICY
                    or entry['components'].get('execution_context')!=digest(context)):
                raise ValueError('shadow_execution_context_not_frozen')
            schedule=session_schedule(session_date,policy=context['session_policy'])
            if head['last_observed_at']:
                previous=(instant(head['last_observed_at']),STAGES.index(head['last_stage']))
                today_previous=instant(head['last_observed_at']).astimezone(TW).date().isoformat()==session_date
                if today_previous:
                    positions=[(instant(f['observed_at']),STAGES.index(f['stage'])) for f in schedule]
                    if previous not in positions:raise ValueError('shadow_previous_frame_outside_schedule')
                    completed=positions.index(previous)+1
            capture=None
            for frame in schedule[completed:]:
                if instant(frame['observed_at'])>clock():break
                if clock()>=frame_capture_deadline(frame):
                    raise ValueError('shadow_expired_frame_without_receipt')
                if capture is None:capture=capture_factory(entry=entry,packet=packet,head=head)
                scoped={**frame,'input_id':digest(['l4-shadow-frame',entry['checksum'],packet['checksum'],frame['input_id']])}
                frozen={**scoped,'source_tables':context['source_tables'],
                        'capture_kv_reads':context['capture_kv_reads'],'kv_read_policy':context['kv_read_policy']}
                accounts.advance(entry_id,action_id=frame['input_id'],expected_state_checksum=head['checksum'],
                    serving_identity=entry['serving_identity'],frames=[scoped],
                    frame_inputs={scoped['input_id']:frozen},variables=context['variables'],capture_source=capture)
                head,_=accounts.current(entry_id);completed+=1
            outcomes.append(dict(entry_id=entry_id,status='execution_complete' if completed==len(schedule) else 'collecting',
                completed_frames=completed,total_frames=len(schedule),state_checksum=head['checksum'],
                # All phases ran, but independent ledger and statistical admission
                # are separate owners and must not be implied by this status.
                accounting_verified=False,outer_acceptance_credit=0))
        except Exception as exc:
            import re
            reason=str(exc)
            outcomes.append(dict(entry_id=entry_id,status='failed',completed_frames=completed,
                reason=reason if re.fullmatch(r'(?:shadow_|native_)[a-z0-9_]+',reason) else 'shadow_source_or_execution_failed',
                error_type=type(exc).__name__))
    return dict(status='failed' if any(row['status']=='failed' for row in outcomes) else 'ok',
        session_date=session_date,accounts=outcomes,production_effect=False,outer_acceptance_credit=0)
