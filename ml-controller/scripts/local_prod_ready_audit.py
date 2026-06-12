#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.local_prod_ready_audit import build_local_prod_ready_audit  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Print StockVision local closure / local prod-ready audit JSON.")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--output")
    args = parser.parse_args()

    audit = build_local_prod_ready_audit(Path(args.repo))
    text = json.dumps(audit, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if audit["local_prod_ready"] == "done" else 2


if __name__ == "__main__":
    raise SystemExit(main())
