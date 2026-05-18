from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ML_CONTROLLER = ROOT / "ml-controller"
sys.path.insert(0, str(ML_CONTROLLER))

from services.external_evidence_runtime import (  # noqa: E402
    build_external_evidence_runtime_packet,
    external_evidence_item_d1_rows,
    normalize_gdelt_article,
    theme_signal_d1_rows,
)


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def _symbols_from_item(item: dict) -> list[str]:
    symbols = item.get("symbols")
    if isinstance(symbols, list):
        return [str(symbol) for symbol in symbols if str(symbol).strip()]
    symbol = item.get("symbol") or item.get("ticker")
    return [str(symbol)] if symbol else []


def _normalized_gdelt_items(items: list[dict]) -> list[dict]:
    normalized = []
    for item in items:
        if item.get("source_id"):
            normalized.append(item)
            continue
        themes = item.get("themes") if isinstance(item.get("themes"), list) else None
        normalized.append(normalize_gdelt_article(item, symbols=_symbols_from_item(item), themes=themes))
    return normalized


def main() -> int:
    parser = argparse.ArgumentParser(description="Build V4.1 external evidence packet and D1 row payloads from a local fixture.")
    parser.add_argument("--input", required=True, help="JSON fixture with gdelt_items/official_items/company_ir_items.")
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "external_evidence_runtime"))
    parser.add_argument("--run-id", default="external-evidence-local")
    parser.add_argument("--generated-at")
    args = parser.parse_args()

    fixture = _load_json(Path(args.input))
    packet = build_external_evidence_runtime_packet(
        gdelt_items=_normalized_gdelt_items(fixture.get("gdelt_items") or []),
        official_items=fixture.get("official_items") or [],
        company_ir_items=fixture.get("company_ir_items") or [],
        generated_at=args.generated_at,
    )
    out = Path(args.output_dir) / args.run_id
    _write_json(out / "packet.json", packet)
    _write_json(out / "theme_signal_rows.json", theme_signal_d1_rows(packet["runtime"]["theme_signals"]))
    _write_json(out / "external_evidence_rows.json", external_evidence_item_d1_rows(packet))
    print(json.dumps(packet["quality_summary"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
