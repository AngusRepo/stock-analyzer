"""Best-effort observation of a Modal invocation, never execution authority."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import time
from urllib.request import Request, urlopen
from uuid import uuid4

@contextmanager
def observe_prediction(payload):
    started_at=datetime.now(timezone.utc).isoformat()
    started=time.monotonic()
    execution='modal-'+uuid4().hex
    def emit(status):
        url=payload.get('callback_url');token=payload.get('callback_token')
        if not url or not token:
            return
        now=datetime.now(timezone.utc).isoformat()
        receipt={'phase':'modal_inference','status':status,'elapsed_ms':round((time.monotonic()-started)*1000),
                 'started_at':started_at,'completed_at':now}
        body={'status':'progress','run_id':payload.get('run_id'),'run_date':payload.get('run_date'),
              'progress':{'phase':'modal_inference','status':status,'started_at':started_at,
                  'phase_started_at':started_at,'observed_at':now,'execution_id':execution,
                  'completed':[] if status=='running' else [receipt]}}
        try:
            request=Request(url,data=json.dumps(body).encode(),headers={'Content-Type':'application/json',
                'Authorization':'Bearer '+token,'X-Service-Token':token})
            with urlopen(request,timeout=3): pass
        except Exception:
            pass  # Observation cannot fail or retry a model invocation.
    emit('running')
    try:
        yield
    except BaseException as exc:
        emit('waiting' if type(exc).__name__=='Suspended' else 'failed')
        raise
    else:
        emit('completed')
