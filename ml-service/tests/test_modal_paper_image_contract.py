"""Validate Paper admission dependencies with only the deployed directory layout."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def test_paper_admission_imports_in_isolated_modal_layout(tmp_path):
    source = (ROOT / "ml-service/modal_app.py").read_text(encoding="utf-8")
    assert '.add_local_dir(str(_LOCAL_SCHEMAS_DIR), remote_path="/root/schemas")' in source
    for source_dir, target in (("ml-controller/services", "services"),
                               ("ml-service/app", "app"), ("schemas", "schemas")):
        shutil.copytree(ROOT / source_dir, tmp_path / target,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    script = r"""
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from services.active8_paper_admission import validate_publication_receipt
from services.evidence_contracts import EXPECTED_RETURN_CONTRACT_MANIFEST_PATH
from services.l4_distribution_lifecycle import validate_acceptance
from services.l4_distribution_runtime import distribution_policy_identity, choose_opb
from services.active8_nav_inference import restore_frozen_nav_inference
from app.serving_resolver import build_pool_from_frozen_manifest
assert EXPECTED_RETURN_CONTRACT_MANIFEST_PATH == Path(sys.argv[1]) / 'schemas/expected-return-contracts-v1.json'
try:
    validate_publication_receipt({}, {})
except ValueError as exc:
    assert str(exc) == 'active8_paper_admission_invalid', str(exc)
else:
    raise AssertionError('invalid receipt accepted')
print('isolated_modal_paper_contract_ready')
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, str(tmp_path)],
                            cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "isolated_modal_paper_contract_ready" in result.stdout
