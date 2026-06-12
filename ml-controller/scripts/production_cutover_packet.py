#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.production_cutover_packet import (  # noqa: E402
    DEFAULT_LOCAL_AUDIT_PATH,
    build_production_cutover_packet,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a non-mutating StockVision production cutover review packet.")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--audit", default=DEFAULT_LOCAL_AUDIT_PATH)
    parser.add_argument("--output")
    args = parser.parse_args()

    packet = build_production_cutover_packet(Path(args.repo), args.audit)
    text = json.dumps(packet, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if packet["cutover_ready_for_review"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
