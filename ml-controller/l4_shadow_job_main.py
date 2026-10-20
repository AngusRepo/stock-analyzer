"""Private shadow Cloud Run Job: explicit bootstrap, daily producer or one tick."""
from datetime import datetime,timezone,timedelta
import json
import os
from pathlib import Path


def run(*,operation=None,session_date=None,accounts=None,now=None,source_index=None,bootstrap=None):
    from services.l4_shadow_producer import initialize,produce_day,DAILY_PREFIX
    operation=operation or os.environ.get('L4_SHADOW_OPERATION','tick')
    now=now or datetime.now(timezone.utc)
    day=session_date or os.environ.get('L4_SHADOW_SESSION_DATE') or now.astimezone(
        timezone(timedelta(hours=8))).date().isoformat()
    if operation not in ('bootstrap','daily','tick'):
        raise ValueError('shadow_job_operation_invalid')
    if operation=='tick':
        from services.l4_shadow_sources import run_tick
        result=run_tick(session_date=day)
        if (result['status']!='ok' or not result.get('accounts') or any(
                row.get('status') not in ('collecting','execution_complete') for row in result['accounts'])):
            raise RuntimeError('shadow_tick_incomplete:'+result['status'])
        return result
    if accounts is None:
        from services.paper_corporate_source import production_objects
        from services.l4_challenger_registry import Registry
        from services.l4_shadow_accounts import Accounts
        from services.kv_client import get
        def identity():
            config=get('trading:config',strict=True)
            if isinstance(config,str):config=json.loads(config)
            artifact=config['l4Distribution']['artifact']
            return dict(l3_payload_checksum=artifact['l3_identity']['payload_checksum'],
                        l4_model_checksum=artifact['model_checksum'])
        objects=production_objects()
        accounts=Accounts(Registry(objects.bucket,formal_identity=identity),
            runner=Path(os.environ.get('NATIVE_PAPER_RUNNER','/app/worker-dist/native-paper.cjs')))
    if operation=='bootstrap':
        if bootstrap is None:
            from services.l4_shadow_producer import read_reference
            reference=json.loads(os.environ.get('L4_SHADOW_BOOTSTRAP_REFERENCE','null'))
            bootstrap=read_reference(accounts.bucket,reference)
        return initialize(accounts,bootstrap)
    if source_index is None:
        blob=accounts.bucket.blob(DAILY_PREFIX+day+'/index.json');blob.reload()
        source_index=json.loads(blob.download_as_bytes(if_generation_match=blob.generation))
    return produce_day(accounts,source_index,session_date=day,now=now)


if __name__=='__main__':
    print(json.dumps(run(),sort_keys=True))
