from __future__ import annotations

import os
import json
from dataclasses import dataclass
from typing import Any, Literal

from services.dataset_snapshots import latest_dataset_snapshot, validate_dataset_snapshot_manifest

ResearchDataMode = Literal["d1_chunked", "snapshot", "auto"]


@dataclass(frozen=True)
class ResearchDataAccessDecision:
    lane: str
    kind: str
    mode: ResearchDataMode
    business_date: str | None
    required_start_date: str | None
    required_end_date: str | None
    source: str
    snapshot: dict[str, Any] | None
    fallback_allowed: bool
    reason: str

    def to_dict(self) -> dict[str, Any]:
        snapshot = self.snapshot or {}
        return {
            "lane": self.lane,
            "kind": self.kind,
            "mode": self.mode,
            "source": self.source,
            "business_date": self.business_date,
            "required_start_date": self.required_start_date,
            "required_end_date": self.required_end_date,
            "fallback_allowed": self.fallback_allowed,
            "reason": self.reason,
            "snapshot_id": snapshot.get("snapshot_id"),
            "snapshot_business_date": snapshot.get("business_date"),
            "snapshot_primary_store": snapshot.get("primary_store"),
            "snapshot_access_tier": snapshot.get("access_tier"),
            "snapshot_gcs_uri": snapshot.get("gcs_uri"),
            "snapshot_r2_key": snapshot.get("r2_key"),
            "snapshot_row_count": snapshot.get("row_count"),
            "snapshot_checksum": snapshot.get("checksum"),
        }


def _snapshot_date_range(snapshot: dict[str, Any] | None) -> tuple[str | None, str | None]:
    if not snapshot:
        return None, None
    metadata = snapshot.get("metadata_json")
    if isinstance(metadata, str) and metadata.strip():
        try:
            parsed = json.loads(metadata)
            return parsed.get("start_date"), parsed.get("end_date")
        except Exception:
            return None, None
    if isinstance(metadata, dict):
        return metadata.get("start_date"), metadata.get("end_date")
    return snapshot.get("start_date"), snapshot.get("end_date")


def latest_snapshot_business_end_date(
    *,
    kind: str,
    as_of_business_date: str | None = None,
    market_segment: str | None = None,
) -> str | None:
    """Return the latest usable business end date for snapshot-backed research.

    Weekly/monthly research jobs run by wall-clock schedules, including
    weekends. Their default replay window must end at the latest ready compute
    snapshot, not at today's calendar date, otherwise the job asks for a
    non-existent future/non-trading snapshot and never reaches the GA/adaptive
    push path.
    """
    snapshot = latest_dataset_snapshot(
        kind=kind,
        as_of_business_date=as_of_business_date,
        access_tier="compute",
        market_segment=market_segment,
    )
    if not snapshot or validate_dataset_snapshot_manifest(snapshot):
        return None
    _start_date, end_date = _snapshot_date_range(snapshot)
    return end_date or snapshot.get("business_date")


def _snapshot_range_errors(
    snapshot: dict[str, Any] | None,
    required_start_date: str | None,
    required_end_date: str | None,
) -> list[str]:
    if not snapshot or not (required_start_date or required_end_date):
        return []
    start_date, end_date = _snapshot_date_range(snapshot)
    errors: list[str] = []
    if required_start_date and (not start_date or start_date > required_start_date):
        errors.append(f"snapshot_start_after_required:{start_date or 'missing'}>{required_start_date}")
    if required_end_date and (not end_date or end_date < required_end_date):
        errors.append(f"snapshot_end_before_required:{end_date or 'missing'}<{required_end_date}")
    return errors


def research_data_mode() -> ResearchDataMode:
    raw = os.environ.get("STOCKVISION_RESEARCH_DATA_SOURCE", "d1_chunked").strip().lower()
    if raw in {"snapshot", "snapshots", "manifest"}:
        return "snapshot"
    if raw in {"auto", "snapshot_auto"}:
        return "auto"
    return "d1_chunked"


def resolve_research_data_access(
    *,
    lane: str,
    kind: str,
    business_date: str | None = None,
    market_segment: str | None = None,
    required_start_date: str | None = None,
    required_end_date: str | None = None,
    mode: ResearchDataMode | None = None,
) -> ResearchDataAccessDecision:
    """Resolve heavy research data access without silent D1 fallback.

    P3 contract:
    - snapshot mode: compute manifest is mandatory; missing/invalid manifest is
      an error.
    - d1_chunked mode: explicit canary/debug fallback; every caller must expose
      the fallback in its response.
    - auto mode: use snapshot when present, otherwise explicit d1 fallback.
    """
    selected = mode or research_data_mode()
    # Research jobs run on wall-clock schedules, while compute snapshots are
    # produced by the latest completed pipeline business date. Resolve as-of
    # the requested run date so weekly/monthly Optuna can use the freshest
    # ready snapshot without silently reaching into future data.
    snapshot = latest_dataset_snapshot(
        kind=kind,
        as_of_business_date=business_date,
        access_tier="compute",
        market_segment=market_segment,
    )
    errors = validate_dataset_snapshot_manifest(snapshot) if snapshot else ["manifest_missing"]
    errors.extend(_snapshot_range_errors(snapshot, required_start_date, required_end_date))
    snapshot_ready = bool(snapshot and not errors)

    if selected == "snapshot":
        if not snapshot_ready:
            raise RuntimeError(
                "research_snapshot_required_but_unavailable:"
                f"lane={lane} kind={kind} date={business_date or 'latest'} errors={','.join(errors)}"
            )
        return ResearchDataAccessDecision(
            lane=lane,
            kind=kind,
            mode=selected,
            business_date=business_date,
            required_start_date=required_start_date,
            required_end_date=required_end_date,
            source="snapshot",
            snapshot=snapshot,
            fallback_allowed=False,
            reason="compute snapshot manifest selected",
        )

    if selected == "auto" and snapshot_ready:
        return ResearchDataAccessDecision(
            lane=lane,
            kind=kind,
            mode=selected,
            business_date=business_date,
            required_start_date=required_start_date,
            required_end_date=required_end_date,
            source="snapshot",
            snapshot=snapshot,
            fallback_allowed=True,
            reason="compute snapshot manifest available",
        )

    return ResearchDataAccessDecision(
        lane=lane,
        kind=kind,
        mode=selected,
        business_date=business_date,
        required_start_date=required_start_date,
        required_end_date=required_end_date,
        source="d1_chunked",
        snapshot=snapshot if snapshot_ready else None,
        fallback_allowed=True,
        reason="explicit D1 chunked fallback; snapshot reader not selected",
    )
