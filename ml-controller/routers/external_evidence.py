from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/external-evidence", tags=["external-evidence"])


class ExternalEvidenceMaterializeRequest(BaseModel):
    target_date: str | None = Field(default=None, description="Optional recommendation date; defaults to latest daily_recommendations date.")
    as_of_date: str | None = Field(default=None, description="Optional evidence as-of date; defaults to target_date.")
    trigger_source: str = "controller"
    dry_run: bool = False


def _parse_last_json(stdout: str) -> dict[str, Any]:
    for line in reversed([line.strip() for line in stdout.splitlines() if line.strip()]):
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _ensure_materializer_env() -> None:
    missing = [name for name in ("CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN") if not os.environ.get(name)]
    if missing:
        raise HTTPException(status_code=409, detail=f"missing external evidence D1 env: {', '.join(missing)}")


@router.post("/materialize")
def materialize_external_evidence(req: ExternalEvidenceMaterializeRequest = Body(default=ExternalEvidenceMaterializeRequest())) -> dict[str, Any]:
    _ensure_materializer_env()

    if req.dry_run:
        return {
            "status": "dry_run",
            "target_date": req.target_date,
            "as_of_date": req.as_of_date or req.target_date,
            "trigger_source": req.trigger_source,
            "would_write": [
                "external_evidence_items",
                "theme_signals",
                "stock_theme_features",
                "source_quality_metrics",
            ],
        }

    for path in ("/app", "/app/tools", "/root", "/root/tools", os.getcwd()):
        if path and path not in sys.path:
            sys.path.insert(0, path)

    old_target = os.environ.get("TARGET_DATE")
    old_as_of = os.environ.get("AS_OF_DATE")
    try:
        if req.target_date:
            os.environ["TARGET_DATE"] = req.target_date
        else:
            os.environ.pop("TARGET_DATE", None)
        if req.as_of_date or req.target_date:
            os.environ["AS_OF_DATE"] = req.as_of_date or req.target_date or ""
        else:
            os.environ.pop("AS_OF_DATE", None)

        module = importlib.import_module("tools.materialize_external_evidence_once")
        module.TARGET_DATE = os.environ.get("TARGET_DATE", "").strip()
        module.AS_OF_DATE = os.environ.get("AS_OF_DATE", "").strip()
        module.GENERATED_AT = datetime.now(timezone.utc).isoformat()

        started = time.time()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            module.main()
        output = stdout.getvalue()
        parsed = _parse_last_json(output)
        gdelt_quality = next(
            (
                row for row in parsed.get("source_quality_metrics", [])
                if isinstance(row, dict) and row.get("source") == "gdelt_events"
            ),
            {},
        )
        return {
            "status": "ok",
            "trigger_source": req.trigger_source,
            "duration_ms": int((time.time() - started) * 1000),
            "target_date": getattr(module, "TARGET_DATE", None),
            "as_of_date": getattr(module, "AS_OF_DATE", None),
            "gdelt_status": parsed.get("gdelt_status"),
            "gdelt_items_built": parsed.get("gdelt_items_built"),
            "stock_theme_features_upserted": parsed.get("stock_theme_features_upserted"),
            "source_quality_root_cause": gdelt_quality.get("metrics_json") if isinstance(gdelt_quality, dict) else None,
            "summary": parsed,
            "stdout_tail": output[-4000:],
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc
    finally:
        if old_target is None:
            os.environ.pop("TARGET_DATE", None)
        else:
            os.environ["TARGET_DATE"] = old_target
        if old_as_of is None:
            os.environ.pop("AS_OF_DATE", None)
        else:
            os.environ["AS_OF_DATE"] = old_as_of
