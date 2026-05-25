from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_execution_smoke import run_finlab_execution_smoke  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read-only FinLab/Sinopac execution lane smoke check.",
    )
    parser.add_argument("--allow-broker-login", action="store_true")
    parser.add_argument("--skip-preview-noop", action="store_true")
    args = parser.parse_args()

    result = run_finlab_execution_smoke(
        allow_broker_login=args.allow_broker_login,
        preview_noop=not args.skip_preview_noop,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
