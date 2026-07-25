from __future__ import annotations

from typing import Any


ELIGIBILITY_SCHEMA_VERSION = "oof-date-eligibility-v2"
ELIGIBILITY_SCOPES = ("active8_oof", "snapshot", "l4", "fusion")


def _date_text(value: Any) -> str:
    text = str(value or "")[:10]
    return text if len(text) == 10 else ""


def build_oof_date_eligibility_rows(
    *,
    cohort_id: str,
    source_manifest_checksum: str,
    prediction_rows: list[dict[str, Any]],
    snapshot_rows: list[dict[str, Any]],
    l4_prediction_rows: list[dict[str, Any]],
    knowledge_cutoff_date: str,
    target_semantic_version: str,
    min_cross_section_rows: int = 20,
) -> list[dict[str, Any]]:
    """Classify immutable OOF, L4, and Fusion readiness per signal date."""

    cutoff = _date_text(knowledge_cutoff_date)
    if not cutoff:
        raise ValueError("oof_date_eligibility_knowledge_cutoff_invalid")
    if len(str(source_manifest_checksum or "")) != 64:
        raise ValueError("oof_date_eligibility_manifest_checksum_invalid")
    predictions_by_date: dict[str, list[dict[str, Any]]] = {}
    snapshots_by_date: dict[str, list[dict[str, Any]]] = {}
    l4_by_date: dict[str, list[dict[str, Any]]] = {}
    for row in prediction_rows:
        prediction_date = _date_text(row.get("prediction_date"))
        if prediction_date:
            predictions_by_date.setdefault(prediction_date, []).append(row)
    for row in snapshot_rows:
        prediction_date = _date_text(
            row.get("snapshot_date") or row.get("prediction_date")
        )
        if prediction_date:
            snapshots_by_date.setdefault(prediction_date, []).append(row)
    for row in l4_prediction_rows:
        prediction_date = _date_text(row.get("prediction_date"))
        if prediction_date:
            l4_by_date.setdefault(prediction_date, []).append(row)

    output: list[dict[str, Any]] = []

    def append(
        prediction_date: str,
        scope: str,
        status: str,
        reason: str,
    ) -> None:
        output.append({
            "cohort_id": cohort_id,
            "prediction_date": prediction_date,
            "evidence_scope": scope,
            "eligibility_status": status,
            "reason_code": reason,
            "evidence_schema_version": ELIGIBILITY_SCHEMA_VERSION,
            "source_manifest_checksum": source_manifest_checksum,
            "evidence_artifact_path": None,
            "evidence_artifact_checksum": None,
            "assessed_knowledge_cutoff": cutoff,
        })

    for prediction_date in sorted(predictions_by_date):
        predictions = predictions_by_date[prediction_date]
        label_dates = [_date_text(row.get("label_known_date")) for row in predictions]
        if (
            any(not value for value in label_dates)
            or any(
                str(row.get("target_semantic_version") or "")
                != target_semantic_version
                for row in predictions
            )
        ):
            active_status, active_reason = "illegal", "active8_lineage_contract_unmet"
        elif any(value > cutoff for value in label_dates):
            active_status, active_reason = "pending", "active8_labels_not_mature"
        else:
            active_status, active_reason = "legal", "active8_purged_oof_complete"
        append(prediction_date, "active8_oof", active_status, active_reason)

        snapshots = snapshots_by_date.get(prediction_date, [])
        if active_status == "pending":
            snapshot_status, snapshot_reason = "pending", "active8_labels_not_mature"
        elif active_status == "illegal":
            snapshot_status, snapshot_reason = "illegal", "active8_lineage_contract_unmet"
        elif len(snapshots) < max(1, int(min_cross_section_rows)):
            snapshot_status, snapshot_reason = "illegal", "snapshot_cross_section_incomplete"
        elif any(
            str(row.get("generation_mode") or "") != "purged_oof"
            or str(row.get("source_manifest_checksum") or "")
            != source_manifest_checksum
            or not _date_text(row.get("label_known_date"))
            or _date_text(row.get("label_known_date")) > cutoff
            for row in snapshots
        ):
            snapshot_status, snapshot_reason = "illegal", "snapshot_pit_contract_unmet"
        else:
            snapshot_status, snapshot_reason = "legal", "allocator_snapshot_pit_complete"
        append(prediction_date, "snapshot", snapshot_status, snapshot_reason)

        l4_rows = l4_by_date.get(prediction_date, [])
        if active_status == "pending":
            l4_status, l4_reason = "pending", "active8_labels_not_mature"
        elif active_status == "illegal":
            l4_status, l4_reason = "illegal", "active8_lineage_contract_unmet"
        elif len(l4_rows) < max(1, int(min_cross_section_rows)):
            l4_status, l4_reason = "illegal", "l4_cross_section_incomplete"
        elif any(
            int(row.get("eligible_for_efficacy") or 0) != 1
            or not _date_text(row.get("trained_until"))
            or _date_text(row.get("trained_until")) >= prediction_date
            for row in l4_rows
        ):
            l4_status, l4_reason = "illegal", "l4_chronological_pit_contract_unmet"
        else:
            l4_status, l4_reason = "legal", "l4_chronological_oof_complete"
        append(prediction_date, "l4", l4_status, l4_reason)

        if l4_status == "pending":
            fusion_status, fusion_reason = "pending", l4_reason
        elif l4_status == "illegal":
            fusion_status, fusion_reason = "illegal", l4_reason
        elif snapshot_status != "legal":
            fusion_status, fusion_reason = snapshot_status, snapshot_reason
        else:
            fusion_status, fusion_reason = "legal", "fusion_selection_evidence_complete"
        append(prediction_date, "fusion", fusion_status, fusion_reason)
    return output


def persist_oof_date_eligibility(rows: list[dict[str, Any]], *, batch_fn) -> dict[str, Any]:
    sql = """
        INSERT INTO active8_oof_date_eligibility (
          cohort_id, prediction_date, evidence_scope, eligibility_status,
          reason_code, evidence_schema_version, source_manifest_checksum,
          evidence_artifact_path, evidence_artifact_checksum,
          assessed_knowledge_cutoff
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cohort_id, prediction_date, evidence_scope) DO UPDATE SET
          eligibility_status=excluded.eligibility_status,
          reason_code=excluded.reason_code,
          evidence_schema_version=excluded.evidence_schema_version,
          source_manifest_checksum=excluded.source_manifest_checksum,
          evidence_artifact_path=excluded.evidence_artifact_path,
          evidence_artifact_checksum=excluded.evidence_artifact_checksum,
          assessed_knowledge_cutoff=excluded.assessed_knowledge_cutoff,
          assessed_at=CURRENT_TIMESTAMP
    """
    statements = [(
        sql,
        [
            row["cohort_id"], row["prediction_date"], row["evidence_scope"],
            row["eligibility_status"], row["reason_code"],
            row["evidence_schema_version"], row.get("source_manifest_checksum"),
            row.get("evidence_artifact_path"), row.get("evidence_artifact_checksum"),
            row["assessed_knowledge_cutoff"],
        ],
    ) for row in rows]
    return batch_fn(statements, timeout=60.0, chunk_size=200)


def classify_oof_retention(
    *,
    legal_dates: int,
    illegal_dates: int,
    pending_dates: int,
    hard_reference_count: int,
    archive_verified: bool,
    cohort_ready: bool,
) -> dict[str, Any]:
    """Return a fail-closed hot-D1 retention decision for one OOF cohort."""

    if pending_dates > 0 or legal_dates + illegal_dates <= 0:
        return {
            "legality_state": "pending",
            "retention_action": "retain_hot",
            "status": "blocked",
            "blocker_reason": "date_eligibility_evidence_incomplete",
        }
    legality_state = (
        "mixed" if legal_dates > 0 and illegal_dates > 0
        else "illegal" if illegal_dates > 0
        else "legal"
    )
    if hard_reference_count > 0 or (cohort_ready and legality_state == "legal"):
        return {
            "legality_state": legality_state,
            "retention_action": "retain_hot",
            "status": "blocked" if hard_reference_count > 0 else "planned",
            "blocker_reason": (
                "active_artifact_hard_reference"
                if hard_reference_count > 0
                else "ready_legal_cohort"
            ),
        }
    if not archive_verified:
        return {
            "legality_state": legality_state,
            "retention_action": "archive_required",
            "status": "planned",
            "blocker_reason": "immutable_archive_not_verified",
        }
    return {
        "legality_state": legality_state,
        "retention_action": "delete_hot",
        "status": "verified",
        "blocker_reason": None,
    }


def build_oof_retention_plan(query_fn) -> list[dict[str, Any]]:
    rows = query_fn(
        """
        SELECT
          c.cohort_id,
          c.status cohort_status,
          SUM(CASE WHEN e.eligibility_status = 'legal' THEN 1 ELSE 0 END) legal_dates,
          SUM(CASE WHEN e.eligibility_status = 'illegal' THEN 1 ELSE 0 END) illegal_dates,
          SUM(CASE WHEN e.eligibility_status = 'pending' THEN 1 ELSE 0 END) pending_dates,
          (SELECT COUNT(*) FROM active8_oof_predictions p WHERE p.cohort_id = c.cohort_id) d1_prediction_rows,
          (SELECT COUNT(*) FROM allocator_ev_oof_snapshots s WHERE s.cohort_id = c.cohort_id) d1_snapshot_rows,
          (SELECT COUNT(*) FROM l4_oof_predictions l WHERE l.cohort_id = c.cohort_id) d1_l4_rows,
          (
            SELECT COUNT(*)
            FROM model_artifact_registry mar
            JOIN artifact_hard_references ref
              ON ref.artifact_id = mar.artifact_id AND ref.active = 1
            WHERE mar.training_run_id = 'active8_oof:' || c.cohort_id
          ) hard_reference_count,
          rl.archive_verified_at,
          rl.archive_checksum
        FROM active8_oof_cohorts c
        LEFT JOIN active8_oof_date_eligibility e
          ON e.cohort_id = c.cohort_id
         AND e.evidence_scope = 'active8_oof'
        LEFT JOIN active8_oof_retention_ledger rl ON rl.cohort_id = c.cohort_id
        GROUP BY c.cohort_id, c.status, rl.archive_verified_at, rl.archive_checksum
        ORDER BY c.cohort_id
        """,
        [],
    )
    plan: list[dict[str, Any]] = []
    for row in rows:
        decision = classify_oof_retention(
            legal_dates=int(row.get("legal_dates") or 0),
            illegal_dates=int(row.get("illegal_dates") or 0),
            pending_dates=int(row.get("pending_dates") or 0),
            hard_reference_count=int(row.get("hard_reference_count") or 0),
            archive_verified=bool(
                row.get("archive_verified_at")
                and len(str(row.get("archive_checksum") or "")) == 64
            ),
            cohort_ready=str(row.get("cohort_status") or "") == "ready",
        )
        plan.append({**row, **decision})
    return plan
