"""Read-only original policy verdicts; mounted under Controller authentication."""
import asyncio
from datetime import datetime, timezone
import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.paired_nav_policy_daily import read_policy_candidate_decision, read_strategy_nav_evidence


router = APIRouter(prefix='/nav', tags=['paired-nav'])
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)


class PolicyDecisionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    owner: Literal['atomic_strategy', 'l15_route']
    candidate_artifact_id: str = Field(min_length=1, max_length=500)
    candidate_checksum: str = Field(pattern=r'^[a-f0-9]{64}$')
    business_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')


class CommittedBaselineRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    artifact_id: str = Field(min_length=1, max_length=500)
    cohort_id: str = Field(min_length=1, max_length=500)
    payload_checksum: str = Field(pattern=r'^[a-f0-9]{64}$')
    base_artifact_set_checksum: str = Field(pattern=r'^[a-f0-9]{64}$')


class StrategyEvidenceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    strategy_id: str = Field(min_length=1, max_length=200)
    strategy_version: str = Field(min_length=1, max_length=200)
    business_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')


@router.post('/strategy-evidence')
async def strategy_evidence(request: StrategyEvidenceRequest):
    clock = datetime.now(timezone.utc)
    try:
        return await asyncio.to_thread(read_strategy_nav_evidence, **request.model_dump(),
            query=LEARNING_D1_CLIENT.query, now=clock)
    except (ValueError, RuntimeError, KeyError, TypeError):
        raise HTTPException(status_code=409, detail='nav_policy_original_evidence_unavailable') from None


@router.post('/committed-l3-baseline')
async def committed_l3_baseline(request: CommittedBaselineRequest):
    from services.active8_nav_baseline import read_committed_nav_baseline
    clock = datetime.now(timezone.utc)
    try:
        return await asyncio.to_thread(read_committed_nav_baseline, formal=request.model_dump(),
            query=LEARNING_D1_CLIENT.query, now=clock)
    except (ValueError, RuntimeError, KeyError, TypeError):
        raise HTTPException(status_code=409, detail='active8_nav_baseline_original_evidence_unavailable') from None


@router.post('/policy-decision')
async def policy_decision(request: PolicyDecisionRequest):
    # Clock, definition, family census and NAV all come from the original owner.
    # This endpoint cannot publish, spend a new review or accept caller PASS.
    clock = datetime.now(timezone.utc)
    try:
        payload = await asyncio.to_thread(read_policy_candidate_decision,
            **request.model_dump(), query=LEARNING_D1_CLIENT.query, now=clock)
    except ValueError as exc:
        reason = str(exc)
        raise HTTPException(status_code=409, detail=reason if re.fullmatch(r'nav_policy_[a-z_]+', reason)
                            else 'nav_policy_original_evidence_unavailable') from None
    return {'schema_version': 'paired-nav-policy-decision-response-v1',
        'owner': request.owner, 'observed_at': clock.isoformat(), 'payload': payload,
        'source': 'original_frozen_policy_and_verified_nav', 'read_only': True}
