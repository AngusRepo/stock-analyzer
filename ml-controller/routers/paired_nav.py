"""Read-only original policy verdicts; mounted under Controller authentication."""
import asyncio
from datetime import datetime, timezone
import re
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain, client_for_domain
from services.paired_nav_policy_daily import read_policy_candidate_decision
from services.strategy_nav_read_model import read_strategy_nav_read_model, production_read_store


log = logging.getLogger(__name__)
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


def _read_strategy_display(request, clock):
    from services.d1_client import read_connection_scope
    started = time.monotonic()
    setup_done = None
    outcome = 'error'
    try:
        with read_connection_scope():
            client = client_for_domain(D1DataDomain.LEARNING)
            store = production_read_store()
            setup_done = time.monotonic()
            result = read_strategy_nav_read_model(**request, client=client, store=store, now=clock)
            outcome = 'success'
            return result
    finally:
        ended = time.monotonic()
        elapsed = ended - started
        emit = log.warning if elapsed >= 5.0 else log.debug
        emit('[StrategyNavRequest] outcome=%s setup_s=%.4f display_s=%.4f total_s=%.4f',
             outcome, (setup_done if setup_done is not None else ended) - started,
             ended - setup_done if setup_done is not None else 0.0, elapsed)


@router.post('/strategy-evidence')
async def strategy_evidence(request: StrategyEvidenceRequest):
    clock = datetime.now(timezone.utc)
    try:
        return await asyncio.to_thread(_read_strategy_display, request.model_dump(), clock)
    except (ValueError, RuntimeError, KeyError, TypeError) as exc:
        reason = str(exc)
        detail = reason if reason in {
            'strategy_nav_read_model_missing', 'strategy_nav_read_model_source_changed',
        } else 'nav_policy_original_evidence_unavailable'
        raise HTTPException(status_code=409, detail=detail) from None


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
