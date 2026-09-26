"""Offline verification of the local correction; never calls real services."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import socket
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
os.chdir(ROOT)
os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"
attempts = []
local_pairs = []
pair_context = threading.local()
real_connect = socket.socket.connect
real_socketpair = socket.socketpair


def deny_network(*args, **kwargs):
    attempts.append("blocked")
    raise RuntimeError("Network access is disabled for this offline audit.")


def guarded_connect(sock, address):
    if getattr(pair_context, "active", False) and isinstance(address, tuple) and address[0] in {"127.0.0.1", "::1"}:
        return real_connect(sock, address)
    return deny_network(sock, address)


def local_socketpair(*args, **kwargs):
    pair_context.active = True
    try:
        result = real_socketpair(*args, **kwargs)
        local_pairs.append("asyncio_internal")
        return result
    finally:
        pair_context.active = False


socket.socketpair = local_socketpair
socket.socket.connect = guarded_connect
socket.socket.connect_ex = deny_network
socket.socket.sendto = deny_network
socket.create_connection = deny_network

import pytest  # noqa: E402


class Results:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.errors = 0

    def pytest_runtest_logreport(self, report):
        if report.when == "call":
            self.passed += int(report.passed)
            self.failed += int(report.failed)
        elif report.failed:
            self.errors += 1
        if report.skipped:
            self.skipped += 1


tests = [
    "test_data_snooping_validation.py",
    "test_statistical_promotion_integration.py",
    "test_validation_governance.py",
    "test_alpha_evidence_runner.py",
    "test_promotion_service.py",
    "test_allocator_ev_fusion_artifact_builder.py",
    "test_parameter_candidate_validation_chain.py",
    "test_lifecycle_promotion_gate.py",
]
results = Results()
output = io.StringIO()
with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
    code = pytest.main(
        [*[f"ml-controller/tests/{name}" for name in tests], "-q", "--tb=short", "-p", "pytest_asyncio.plugin"],
        plugins=[results],
    )
OUT.joinpath("pytest-offline.log").write_text(output.getvalue(), encoding="utf-8")
sources = [
    "ml-controller/services/data_snooping_validation.py",
    "ml-controller/services/validation_governance.py",
    "ml-controller/services/promotion_service.py",
    "ml-controller/services/alpha_evidence_runner.py",
    "ml-controller/services/allocator_ev_fusion_artifact_builder.py",
    "ml-controller/routers/config_pool.py",
    *[f"ml-controller/tests/{name}" for name in tests],
]
record = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "scope": "local_working_tree_offline_fixtures_only",
    "python": sys.version.split()[0],
    "exit_code": int(code),
    "passed": results.passed,
    "failed": results.failed,
    "skipped": results.skipped,
    "errors": results.errors,
    "blocked_network_attempts": len(attempts),
    "allowed_internal_socketpairs": len(local_pairs),
    "tests": tests,
    "source_sha256": {name: hashlib.sha256(ROOT.joinpath(name).read_bytes()).hexdigest() for name in sources},
    "limitations": [
        "No production, deployment, retraining or live trading verification.",
        "Search completeness relies on a caller-declared manifest; historical trial ledger ingestion is not implemented here.",
        "Equal-length ordered partitions are enforced; timestamp identity must be supplied correctly by the caller.",
        "Current main exact DSR v2 and its trial-distribution lineage gates were preserved unchanged.",
    ],
}
OUT.joinpath("verification.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(output.getvalue())
print(json.dumps({k: record[k] for k in ["exit_code", "passed", "failed", "skipped", "errors", "blocked_network_attempts"]}))
raise SystemExit(int(code))
