"""Dedicated private Cloud Run app for StockVision broker execution.

Do not mount this route in the general ml-controller service. Runtime keeps
max=1, continuous CPU and a private invoker; min=1 is mandatory before broker
read or live-submit is enabled, while a fully disabled gateway remains min=0.
"""

from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from services.broker_execution_repository import D1BrokerExecutionRepository
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
from services.finlab_live_submit_service import run_finlab_live_submit
from services.finlab_execution_shadow_service import run_finlab_execution_shadow


SERVICE_ROLE = os.environ.get("EXECUTION_GATEWAY_SERVICE_ROLE", "")
SERVICE_TOKEN = os.environ.get("EXECUTION_GATEWAY_SERVICE_TOKEN", "")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

repository = D1BrokerExecutionRepository()
gateway = PersistentFinlabExecutionGateway(repository, env=os.environ)


class ExecuteRequest(BaseModel):
    packet: dict[str, Any] = Field(default_factory=dict)
    allow_live_submit: bool = False


class ShadowRequest(BaseModel):
    packet: dict[str, Any] = Field(default_factory=dict)


class PaperReturnRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=500)


class AccountObservationRequest(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)


def _verify_service_token(authorization: str | None) -> None:
    if SERVICE_ROLE != "dedicated_execution_gateway":
        raise HTTPException(503, "dedicated execution gateway role not configured")
    if not SERVICE_TOKEN:
        if ENVIRONMENT == "production":
            raise HTTPException(500, "execution gateway service token not configured")
        raise HTTPException(503, "execution gateway disabled")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "unauthorized")
    if not hmac.compare_digest(authorization[7:], SERVICE_TOKEN):
        raise HTTPException(401, "invalid execution gateway token")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    gateway.close()


app = FastAPI(title="StockVision Execution Gateway", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    state = gateway.health()
    return {
        "status": "ready" if state.get("healthy") else "disabled_or_not_started",
        "service_role_ready": SERVICE_ROLE == "dedicated_execution_gateway",
        "live_submit_enabled": str(os.environ.get("FINLAB_LIVE_SUBMIT_ENABLED") or "").lower() in {"1", "true", "yes", "enabled"},
        "execution_shadow_enabled": str(os.environ.get("LIVE_EXECUTION_SHADOW_ENABLED") or "").lower() in {"1", "true", "yes", "enabled"},
        "shadow_broker_read_enabled": str(os.environ.get("LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED") or "").lower() in {"1", "true", "yes", "enabled"},
        "gateway": state,
    }


@app.post("/v1/execute")
def execute(
    req: ExecuteRequest,
    authorization: str | None = Header(default=None),
    x_execution_signature: str | None = Header(default=None, alias="X-Execution-Signature"),
) -> dict[str, Any]:
    _verify_service_token(authorization)
    return run_finlab_live_submit(
        packet=req.packet or None,
        signature=x_execution_signature,
        allow_live_submit=req.allow_live_submit,
        repository=repository,
        gateway=gateway,
    )


@app.post("/v1/shadow/validate")
def validate_shadow(
    req: ShadowRequest,
    authorization: str | None = Header(default=None),
    x_execution_signature: str | None = Header(default=None, alias="X-Execution-Signature"),
) -> dict[str, Any]:
    _verify_service_token(authorization)
    return run_finlab_execution_shadow(
        packet=req.packet or None,
        signature=x_execution_signature,
        repository=repository,
        gateway=gateway,
    )


@app.post("/v1/control/return-to-paper")
def return_to_paper(req: PaperReturnRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _verify_service_token(authorization)
    try:
        return gateway.return_to_paper(request_id=req.request_id, reason=req.reason)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, "paper return not confirmed") from exc


@app.get("/v1/control/submission-state")
def submission_state(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _verify_service_token(authorization)
    try:
        receipt = gateway.submission_control.paused_receipt()
        return {"status": "live_submission_paused" if receipt else "not_paused",
                "receipt": receipt, "live_admission_granted": False}
    except Exception as exc:
        raise HTTPException(503, "live submission state unavailable") from exc


@app.get("/v1/intents/{idempotency_key}")
def intent_status(idempotency_key: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _verify_service_token(authorization)
    lifecycle = repository.intent_lifecycle(idempotency_key)
    if lifecycle is None:
        raise HTTPException(404, "execution intent not found")
    return {"status": "ok", **lifecycle}


@app.post("/v1/account/observations")
def capture_account_observation(req: AccountObservationRequest,
                                authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _verify_service_token(authorization)
    try:
        return gateway.capture_account_observation(request_id=req.request_id)
    except ValueError as exc:
        raise HTTPException(422, "live account source rejected") from exc
    except Exception as exc:
        raise HTTPException(503, "live account observation unavailable") from exc
