"""Authenticated Worker account/plan bridge. No inferred account balances."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import os
from urllib.parse import urlsplit


def worker_request(path, payload, *, transport=None):
    import httpx
    endpoint=os.environ.get('STOCKVISION_WORKER_URL','').strip().rstrip('/')
    token=os.environ.get('STOCKVISION_AUTH_TOKEN','').strip()
    url=urlsplit(endpoint)
    if url.scheme!='https' or not url.netloc or url.username or url.password or url.query or url.fragment or not token:
        raise ValueError('l4_distribution_worker_unconfigured')
    try:
        response=(transport or httpx.post)(endpoint+path,json=payload,
            headers={'Authorization':'Bearer '+token},timeout=45,follow_redirects=False)
    except httpx.RequestError:
        raise RuntimeError('l4_distribution_worker_transport_failed') from None
    if response.status_code!=200:
        raise RuntimeError('l4_distribution_worker_http_failed:'+str(response.status_code))
    return response.json()


def prepare_runtime_policy(*,policy,signal_date,predictions,manifest,account_reader=None,reward_reader=None):
    from services.paired_nav_collection import baseline_model_identity
    from services.l4_distribution import validate_bundle
    frozen=deepcopy(policy)
    if frozen.get('scope')!='paper':
        raise ValueError('l4_distribution_paper_scope_required')
    identity=baseline_model_identity(manifest)
    validate_bundle(frozen['artifact'],l3_identity=identity,signal_date=signal_date)
    start=datetime.now(timezone.utc)
    account=(account_reader or (lambda day:worker_request('/api/internal/l4-distribution/account',{'signal_date':day})))(signal_date)
    if not account.get('risk_limits') or not account.get('fees'):
        raise ValueError('l4_distribution_canonical_risk_context_missing')
    observed=datetime.fromisoformat(account['observed_at'].replace('Z','+00:00'))
    if not start-timedelta(seconds=5)<=observed<=datetime.now(timezone.utc)+timedelta(seconds=5):
        raise ValueError('l4_distribution_account_observation_stale')
    frozen['runtime']={'signal_date':signal_date,'l3_identity':identity,'account':account,'predictions':deepcopy(predictions)}
    if reward_reader is None:
        def reward_reader():
            from services.d1_domain_client import client_proxy_for_domain
            import json
            rows=client_proxy_for_domain('paper').query(
                'SELECT payload_json FROM l4_policy_account_rewards_v1 WHERE known_date<? ORDER BY known_date,receipt_id',
                [signal_date])
            return [json.loads(row['payload_json']) for row in rows]
    frozen['_account_rewards']=reward_reader() if (frozen.get('opb') or {}).get('enabled') else []
    return frozen


def publish_plan(plan, allocation_snapshot_id):
    import json
    canonical=json.dumps({k:v for k,v in plan.items() if k!='plan_id'},sort_keys=True,separators=(',',':'),allow_nan=False)
    result=worker_request('/api/internal/l4-distribution/plan',{'plan':plan,'canonical_payload':canonical,'allocation_snapshot_id':allocation_snapshot_id})
    if result.get('plan_id')!=plan['plan_id'] or result.get('status')!='stored':
        raise ValueError('l4_distribution_plan_publication_failed')
    return result
