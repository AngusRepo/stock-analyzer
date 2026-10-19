"""Authenticated source and private execution endpoints; no formal account writes."""
import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ConfigDict

from services.paper_corporate_source import materialize_corporate_source, production_objects

router = APIRouter(prefix='/paper', tags=['paper-source'])


class NativeTickRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')


@router.post('/native-execution-tick')
async def native_execution_tick(request: NativeTickRequest):
    # The former paired scheduler has no execution authority after single-B cutover.
    # Historical accounting/replay functions remain available to their explicit owners.
    return {'status': 'disabled_by_single_b_policy', 'pairs': [], 'executed': 0}


@router.post('/strategy-nav-execution-tick')
async def strategy_nav_execution_tick(request: NativeTickRequest):
    from services.paired_native_runtime import run_strategy_execution_tick
    from services.l4_r17_runtime import run_execution_tick as r17_tick, safe_failure
    # Independent shadow accounts: a legacy strategy failure must not starve
    # R17, and R17 failure must not suppress the original strategy invocation.
    results=await asyncio.gather(
        asyncio.to_thread(run_strategy_execution_tick,session_date=request.session_date),
        asyncio.to_thread(r17_tick,request.session_date),return_exceptions=True)
    legacy,shadow=results
    if isinstance(shadow,Exception):shadow=safe_failure(shadow)
    if shadow.get('status')!='not_activated':
        if isinstance(legacy,Exception):legacy=safe_failure(legacy)
        failure=legacy.get('status')=='failed' or shadow.get('status') in ('failed','execution_gap')
        return {**legacy,'r17':shadow,'status':'failed' if failure else legacy.get('status','ok')}
    try:
        if isinstance(legacy,Exception):raise legacy
        return legacy
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


class CorporateSourceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_date: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    scope_id: str = Field(pattern=r'^(paper-account-1|paired-[a-f0-9]{64})$')
    symbols: list[str] = Field(max_length=2000)
    outstanding_action_ids: list[str] = Field(max_length=2000)
    historical_cash_dates: dict[str, list[str]] | None = Field(default=None, max_length=2000)


@router.post('/corporate-source')
async def corporate_source(request: CorporateSourceRequest):
    try:
        return await asyncio.to_thread(materialize_corporate_source,
            **request.model_dump(), objects=production_objects())
    except ValueError as exc:
        # Source parsers use bounded reason codes, not raw credential responses.
        raise HTTPException(status_code=409, detail=str(exc)) from None
