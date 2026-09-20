"""Export verified, frozen research accounts for the read-only NAV comparison UI.

No model training, remote access, production writes or invented rebate receipts.
Run again after independently verifying a replacement comparison manifest.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "audits/native-model-comparison-20260920"
MODELS = {"price_three": "primary", "exo137_stack": "challenger"}


def native(path: Path) -> Path:
    return Path("\\\\?\\" + str(path.resolve())) if os.name == "nt" and not str(path).startswith("\\\\?\\") else path


def export() -> dict:
    manifest_path = EVIDENCE / "prod-adjudication/robustness-comparison.json"
    manifest_bytes = native(manifest_path).read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["complete"] is True
    scenarios: dict[str, dict] = {}
    for record in manifest["accounts"]:
        if record["model"] not in MODELS:
            continue
        path = Path(record["file"].removeprefix("\\\\?\\"))
        raw = native(path).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        assert digest == record["sha256"], f"Changed account: {path}"
        assert record["cash_conservation_max_error"] < 0.01
        assert record["NAV_conservation_max_error"] < 0.01
        account = json.loads(raw)
        fills = [{k: f[k] for k in ("date", "symbol", "side", "shares", "price", "commission", "tax", "slippage_cost")} for f in account["fills"]]
        assert math.isclose(sum(f["commission"] + f["tax"] for f in fills), account["summary"]["fees_and_tax"], abs_tol=0.01)
        ledger = [{k: day[k] for k in ("date", "cash", "nav", "exposure", "positions")} | {"symbols": sorted(day["units"])} for day in account["ledger"]]
        assert not any(day["stale_symbols"] for day in account["ledger"])
        assert len({d["date"] for d in ledger}) == len(ledger)
        assert all(f["date"] in {d["date"] for d in ledger} for f in fills)
        assert math.isclose(ledger[-1]["nav"] / 1_000_000 - 1, account["summary"]["net_return"], abs_tol=1e-10)
        key = f"{record['start']}_{record['cost_bps']:g}"
        scenario = scenarios.setdefault(key, {"id": key, "signal_start": record["start"], "slippage_bps": record["cost_bps"], "accounts": {}})
        role = MODELS[record["model"]]
        assert role not in scenario["accounts"]
        scenario["accounts"][role] = {
            "model": record["model"], "source": path.relative_to(ROOT).as_posix(), "sha256": digest,
            "summary": account["summary"], "ledger": ledger, "fills": fills,
        }
    for scenario in scenarios.values():
        assert set(scenario["accounts"]) == {"primary", "challenger"}
        assert [d["date"] for d in scenario["accounts"]["primary"]["ledger"]] == [d["date"] for d in scenario["accounts"]["challenger"]["ledger"]]
    assert len(scenarios) == 10
    return {
        "schema_version": 1, "kind": "frozen_research_replay", "evidence_date": "2026-09-20",
        "valuation_through": "2026-09-18", "last_signal_date": "2026-09-11", "mlp_active_from": "2026-09-02",
        "initial_cash": 1_000_000, "promotion_credit": False,
        "manifest_source": manifest_path.relative_to(ROOT).as_posix(), "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "scenarios": sorted(scenarios.values(), key=lambda s: (s["slippage_bps"], s["signal_start"])),
    }


if __name__ == "__main__":
    payload = export()
    output = ROOT / "frontend/src/data/candidateComparisonResearch.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"accounts": sum(len(s["accounts"]) for s in payload["scenarios"]), "scenarios": len(payload["scenarios"]), "output": str(output)}))
