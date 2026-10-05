from typing import Literal
from fastapi import APIRouter
from pydantic import BaseModel, Field
from services.d1_domain_client import client_proxy_for_domain
from services.l4_distribution_context import worker_request, publish_plan
from services.l4_replan import replan

router=APIRouter(prefix='/l4_distribution',tags=['l4_distribution'])

class ReplanRequest(BaseModel):
    plan_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    veto_symbols: list[str] = Field(default_factory=list,max_length=3000)
    weight_caps: dict[str,float] = Field(default_factory=dict,max_length=3000)
    reason: str = Field(min_length=1,max_length=200)

@router.post('/replan')
def replan_portfolio(request: ReplanRequest):
    return replan(**request.model_dump(),paper=client_proxy_for_domain('paper'),
        leases=client_proxy_for_domain('ops'),
        learning=client_proxy_for_domain('learning'),
        account_reader=lambda day:worker_request('/api/internal/l4-distribution/account',{'signal_date':day}),
        publisher=publish_plan)


class RefreshRequest(BaseModel):
    end_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    cadence: str = Field(pattern=r'^(weekly|monthly|manual)$')
    target_l3_artifact_id: str | None = Field(default=None,max_length=400)
    strategy_role: Literal["A", "B"] | None = None
    promote: bool = False
    dry_run: bool = False

@router.post('/refresh')
def refresh_distribution(request: RefreshRequest):
    from fastapi import HTTPException
    from services.trading_config_loader import load_merged_trading_config_with_contract
    from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError
    import os
    if request.promote:
        raise HTTPException(409,'l4_distribution_requires_paired_paper_release')
    config=load_merged_trading_config_with_contract().config
    policy = config.get('l4Distribution') or {}
    single_b = policy.get('operating_mode') == 'single_b_tabpack_v1'
    role = request.strategy_role or ('B' if single_b else 'A')
    if single_b and role != 'B':
        raise HTTPException(409, 'single_b_refresh_cannot_train_A')
    target = request.target_l3_artifact_id
    if role == 'B' and not target:
        # Monthly candidates must follow the new L3 candidate from the canonical
        # OOF chain, never silently use the incumbent serving parent.
        raise HTTPException(409,'l4_B_requires_explicit_exo_parent')
    if config.get('l4Distribution') is None and not request.target_l3_artifact_id:
        raise HTTPException(409,'new_l4_policy_not_configured')
    if request.dry_run:
        return {'status':'dry_run','promoted':False,'training_dispatched':False}
    try:
        job=CloudRunJobsClient(job_name=os.environ.get('L4_DISTRIBUTION_JOB_NAME','l4-distribution-refresh')).run_job(
            env_overrides={'L4_REFRESH_DATE':request.end_date,'L4_REFRESH_CADENCE':request.cadence,'L4_STRATEGY_ROLE':role,
                **({'L4_PARENT_ARTIFACT_ID':request.target_l3_artifact_id} if request.target_l3_artifact_id else {})})
    except JobAlreadyRunningError as exc:
        return {'status':'pending','execution_id':exc.execution.execution_id,'promoted':False}
    return {'status':'spawned','execution_id':job.execution_id,'promoted':False}


@router.get('/monthly-closure/{checksum}')
def monthly_training_closure(checksum: str):
    """Read-only artifact-backed verification for the authenticated Worker callback."""
    from fastapi import HTTPException
    from services.l4_monthly_closure import verify
    from services.pipeline_input_events import bucket
    try:
        return verify(checksum, bucket(), client_proxy_for_domain('learning'))
    except (ValueError, KeyError) as exc:
        raise HTTPException(409, str(exc)) from exc
