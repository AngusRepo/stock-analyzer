from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def _pointer(row_id: int, artifact: int = 1) -> dict:
    return {
        "row_id": row_id,
        "artifact_id": f"artifact:legacy_screener_funnel_evidence:2026-07-07:{artifact}",
        "r2_key": (
            "evidence/class=superseded_run/domain=legacy_screener_funnel_evidence/"
            f"business_date=2026-07-07/chunk={artifact}.json"
        ),
        "checksum": "sha256:" + str(artifact) * 64,
        "source_run_id": f"run-{artifact}",
        "symbol": str(2300 + row_id),
        "stage": "scoring",
    }


def test_resolver_batches_artifacts_and_requires_exact_row_coverage():
    from services.worker_evidence_archive_client import resolve_legacy_screener_evidence

    pointers = [_pointer(1, 1), _pointer(2, 2), _pointer(3, 3)]
    calls = []

    def post(payload):
        calls.append(payload)
        rows = []
        for artifact in payload["artifacts"]:
            for row_id in artifact["row_ids"]:
                pointer = next(item for item in pointers if item["row_id"] == row_id)
                rows.append({**pointer, "evidence": '{"score_components": {}}'})
        return {"ok": True, "rows": rows}

    resolved = resolve_legacy_screener_evidence(pointers, post_fn=post)

    assert sorted(resolved) == [1, 2, 3]
    assert [len(call["artifacts"]) for call in calls] == [2, 1]


def test_resolver_splits_single_large_artifact_at_worker_row_limit():
    from services.worker_evidence_archive_client import resolve_legacy_screener_evidence

    pointers = [_pointer(row_id) for row_id in range(1, 402)]
    batch_sizes = []

    def post(payload):
        row_ids = [row_id for artifact in payload["artifacts"] for row_id in artifact["row_ids"]]
        batch_sizes.append(len(row_ids))
        rows = []
        for row_id in row_ids:
            pointer = pointers[row_id - 1]
            rows.append({**pointer, "evidence": "{}"})
        return {"ok": True, "rows": rows}

    resolved = resolve_legacy_screener_evidence(pointers, post_fn=post)

    assert len(resolved) == 401
    assert batch_sizes == [400, 1]


def test_resolver_fails_closed_when_archive_omits_a_row():
    from services.worker_evidence_archive_client import resolve_legacy_screener_evidence

    with pytest.raises(RuntimeError, match="missing_rows"):
        resolve_legacy_screener_evidence(
            [_pointer(1)],
            post_fn=lambda _payload: {"ok": True, "rows": []},
        )


def test_resolver_fails_closed_on_symbol_mismatch():
    from services.worker_evidence_archive_client import resolve_legacy_screener_evidence

    pointer = _pointer(1)
    with pytest.raises(RuntimeError, match="row_mismatch"):
        resolve_legacy_screener_evidence(
            [pointer],
            post_fn=lambda _payload: {
                "ok": True,
                "rows": [{**pointer, "symbol": "9999", "evidence": "{}"}],
            },
        )
