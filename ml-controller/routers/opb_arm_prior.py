from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.model_artifact_registry import upsert_artifact_record, d1_client as artifact_registry_d1
from services.opb_counterfactual_prior import (
    build_opb_arm_prior_artifact,
    load_opb_counterfactual_inputs,
)

router = APIRouter(prefix="/opb_arm_prior", tags=["opb_arm_prior"])


class OpbArmPriorRefreshReq(BaseModel):
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_return_owner: Literal["l4_alpha_ev", "allocator_ev_fusion"] = "allocator_ev_fusion"
    lookback_days: int = Field(default=120, ge=30, le=365)
    min_dates: int = Field(default=20, ge=10, le=252)
    limit: int = Field(default=10000, ge=500, le=20000)
    roundtrip_cost_bps: float = Field(default=18.0, ge=0.0, le=100.0)
    promote: bool = False
    dry_run: bool = True
    reuse_registered: bool = False
    trigger_source: str = "manual"


def _checksum(artifact: dict[str, Any]) -> str:
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _registry_record(artifact: dict[str, Any], *, promoted: bool, promotion_error: str | None) -> dict[str, Any]:
    if promoted or promotion_error:
        raise ValueError('opb_refresh_cannot_publish_or_update_nav_lifecycle')
    validation = artifact.get("validation") if isinstance(artifact.get("validation"), dict) else {}
    passed = str(validation.get("decision") or "").upper() == "PASS"
    version = str(artifact.get("model_version") or "unknown")
    state = "offline_passed" if passed else "offline_failed"
    return {
        "artifact_id": artifact.get("artifact_id") or f"opb_arm_prior:{version}",
        "model_name": "opb_arm_prior",
        "version": version,
        "candidate_type": "opb_arm_prior_refresh",
        "state": state,
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"opb_arm_prior_refresh:{artifact.get('trained_until')}:{artifact.get('expected_return_owner')}",
        "training_manifest_path": None,
        "trained_from_snapshot": "allocator_ev_feature_snapshots",
        "evaluation_baseline_version": None,
        "final_compared_to": None,
        "feature_policy_version": artifact.get("expected_return_owner"),
        "checksum": _checksum(artifact),
        "source_run_date": artifact.get("trained_until"),
        "is_monthly": 0,
        "offline_gate_status": "passed" if passed else "failed",
        "offline_gate_decision": validation.get("decision"),
        "offline_gate_failed_gates": json.dumps(validation.get("failed_checks") or []),
        "offline_evidence_json": json.dumps(artifact, ensure_ascii=False),
        "live_gate_status": "not_started",
        "live_evidence_json": json.dumps({"promoted": False, "promotion_error": None}),
        "promotion_decision": "shadow_prior",
        "approval_state": "not_required",
    }


_PUBLICATION_COLUMNS = ('state', 'live_gate_status', 'live_evidence_json',
                        'promotion_decision', 'approval_state')


def _validate_generated_at(artifact: dict[str, Any]) -> None:
    try:
        instant = datetime.fromisoformat(str(artifact.get('generated_at') or '').replace('Z', '+00:00'))
        if instant.tzinfo is None or instant > datetime.now(timezone.utc):
            raise ValueError('unavailable generation time')
    except (TypeError, ValueError) as exc:
        raise ValueError('opb_artifact_generation_time_invalid') from exc


def _read_prior_record(artifact_id: str) -> dict[str, Any] | None:
    rows = artifact_registry_d1.query('SELECT * FROM model_artifact_registry WHERE artifact_id=? LIMIT 2',
                                     [artifact_id])
    if len(rows) > 1:
        raise RuntimeError('opb_registry_identity_ambiguous')
    return rows[0] if rows else None


def _verified_sealed_prior(row: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    sealed = json.loads(row.get('offline_evidence_json') or 'null')
    if not isinstance(sealed, dict) or row.get('checksum') != _checksum(sealed):
        raise RuntimeError('opb_registry_payload_checksum_mismatch')
    _validate_generated_at(sealed)
    # Only ephemeral build time may differ on a same-content retry. Always
    # return the actual first persisted bytes/time, never rewrite its evidence.
    semantic = lambda artifact: {k: v for k, v in artifact.items() if k != 'generated_at'}
    if semantic(sealed) != semantic(candidate):
        raise RuntimeError('opb_registry_immutable_identity_conflict')
    expected = _registry_record(sealed, promoted=False, promotion_error=None)
    immutable = set(expected) - set(_PUBLICATION_COLUMNS) - {'final_compared_to'}
    if any(row.get(key) != expected[key] for key in immutable):
        raise RuntimeError('opb_registry_metadata_identity_mismatch')
    return sealed


def _seal_prior_before_publication(candidate: dict[str, Any], *, preview: bool = False
                                   ) -> tuple[dict[str, Any], dict[str, Any] | None]:
    _validate_generated_at(candidate)
    row = _read_prior_record(candidate['artifact_id'])
    if preview and row is None:
        return candidate, None
    if row is None:
        try:
            upsert_artifact_record(_registry_record(candidate, promoted=False, promotion_error=None),
                                   immutable_identity=True)
        except Exception:
            # A competing first writer or lost ACK is recoverable only when
            # original readback proves the same immutable content below.
            row = _read_prior_record(candidate['artifact_id'])
            if row is None:
                raise
        if row is None:
            row = _read_prior_record(candidate['artifact_id'])
    if row is None:
        raise RuntimeError('opb_registry_write_readback_mismatch')
    return _verified_sealed_prior(row, candidate), row


@router.post("/refresh")
async def refresh_opb_arm_prior(req: OpbArmPriorRefreshReq) -> dict[str, Any]:
    # Event recovery reuses the first compatible frozen registration, not a
    # refreshed retrospective data query. All other registered candidates remain
    # in the original daily comparison inventory and family denominator.
    reused = None
    if req.reuse_registered:
        records = artifact_registry_d1.query(
            'SELECT * FROM model_artifact_registry WHERE model_name=? AND training_run_id=? '
            'ORDER BY created_at,artifact_id',
            ['opb_arm_prior', f'opb_arm_prior_refresh:{req.end_date}:{req.expected_return_owner}'])
        for record in records:
            saved = json.loads(record.get('offline_evidence_json') or 'null')
            if not isinstance(saved, dict):
                raise ValueError('opb_registry_payload_checksum_mismatch')
            _verified_sealed_prior(record, saved)
            if (saved.get('expected_return_owner') == req.expected_return_owner
                    and saved.get('trained_until') == req.end_date
                    and saved.get('roundtrip_cost_bps') == req.roundtrip_cost_bps
                    and (saved.get('validation') or {}).get('minimum_dates_per_arm') == req.min_dates):
                reused = saved
                break
    rows, price_rows = [], []
    if reused is None:
        rows, price_rows = load_opb_counterfactual_inputs(
            end_date=req.end_date, lookback_days=req.lookback_days, limit=req.limit)
        result = build_opb_arm_prior_artifact(
            rows, price_rows, expected_return_owner=req.expected_return_owner,
            trained_until=req.end_date, min_dates=req.min_dates,
            roundtrip_cost_bps=req.roundtrip_cost_bps)
    else:
        result = {'artifact': reused, 'status': 'validated'
                  if reused['validation']['decision'] == 'PASS' else 'failed_validation'}
    artifact = result["artifact"]
    if artifact.get('expected_return_owner') != req.expected_return_owner or artifact.get('trained_until') != req.end_date:
        raise ValueError('opb_artifact_request_identity_mismatch')
    registry_error: str | None = None
    registry_verified = False
    prior_record = None
    try:
        artifact, prior_record = _seal_prior_before_publication(artifact, preview=req.dry_run)
        result = {**result, 'artifact': artifact}
        registry_verified = prior_record is not None
    except Exception as exc:
        registry_error = str(exc)
    # Registration owns immutable candidate bytes only. Offline diagnostics,
    # a manual promote flag, or a retry cannot mutate NAV decisions/config.
    # The daily NAV owner consumes registered candidates and publishes them.
    return {
        **result,
        'schema_version': 'opb-candidate-registration-v1',
        'completion_scope': 'candidate_registration',
        'status': 'registration_incomplete' if registry_error else 'preview' if req.dry_run else 'candidate_registered',
        'diagnostic_status': result['status'],
        'candidate_reused': reused is not None,
        'candidate_state': prior_record['state'] if prior_record else None,
        'artifact_checksum': prior_record['checksum'] if prior_record else None,
        "rows_loaded": len(rows),
        "price_rows_loaded": len(price_rows),
        'promotion_requested': req.promote,
        'promotion_owner': 'daily_nav',
        "promoted": False,
        "promotion_error": None,
        "registry_error": registry_error,
        'registry_verified': registry_verified,
        'config_projection_verified': False,
        "production_mutation_allowed": False,
    }
