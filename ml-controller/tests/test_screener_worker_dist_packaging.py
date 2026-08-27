from __future__ import annotations

import posixpath
from pathlib import Path


def test_worker_dist_preserves_source_depth_for_repo_root_contracts():
    dockerfile = Path("Dockerfile").read_text(encoding="utf-8")
    compiled_lib = "/app/worker-dist/src/lib"

    assert "--outDir /app/worker-dist/src" in dockerfile
    assert posixpath.normpath(
        f"{compiled_lib}/../../../schemas/expected-return-contracts-v1.json"
    ) == "/app/schemas/expected-return-contracts-v1.json"
    assert posixpath.normpath(
        f"{compiled_lib}/../../../data/finlab_source_contract.json"
    ) == "/app/data/finlab_source_contract.json"
    assert posixpath.normpath(
        f"{compiled_lib}/../../../infra/gcp-scheduler-jobs.json"
    ) == "/app/infra/gcp-scheduler-jobs.json"


def test_image_build_smokes_both_worker_dependency_graphs_without_running_jobs():
    dockerfile = Path("Dockerfile").read_text(encoding="utf-8")

    assert "require('/app/worker-dist/src/lib/evidenceContracts.js')" in dockerfile
    assert "require('/app/worker-dist/src/lib/finlabSourceContract.js')" in dockerfile
    assert "require('/app/worker-dist/src/lib/schedulerExecutionTickets.js')" in dockerfile
    assert "require('/app/worker-dist/src/lib/marketScreener.js')" in dockerfile
    assert (
        "require('/app/worker-dist/src/lib/s12ResearchStructureSnapshots.js')"
        in dockerfile
    )
    assert "require('/app/worker-dist/src/node-runner/" not in dockerfile


def test_python_job_entrypoints_match_compiled_worker_layout():
    screener = Path("ml-controller/screener_job_main.py").read_text(encoding="utf-8")
    s12 = Path("ml-controller/s12_structure_job_main.py").read_text(encoding="utf-8")

    assert '"/app/worker-dist/src/node-runner/screenerJobMain.js"' in screener
    assert '"/app/worker-dist/src/node-runner/s12StructureBatchJobMain.js"' in s12
