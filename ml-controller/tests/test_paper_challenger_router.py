from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers.paper_challenger import PaperChallengerPostmarketRequest, build_postmarket_report  # noqa: E402


def test_paper_challenger_postmarket_router_builds_report_without_real_trading_effect():
    req = PaperChallengerPostmarketRequest(
        run_date="2026-05-17",
        candidates=[
            {
                "candidate_id": "finlab-broker-concentration",
                "candidate_type": "finlab_feature",
                "current_state": "paper_active_challenger",
            }
        ],
        baseline_metrics_by_candidate={
            "finlab-broker-concentration": {
                "precision_at_k": 0.50,
                "hit_rate": 0.52,
                "avg_return_pct": 2.4,
                "max_drawdown_pct": -6.0,
                "turnover_ratio": 2.0,
            }
        },
        challenger_metrics_by_candidate={
            "finlab-broker-concentration": {
                "paper_decision_count": 35,
                "precision_at_k": 0.54,
                "hit_rate": 0.55,
                "avg_return_pct": 2.9,
                "max_drawdown_pct": -6.2,
                "turnover_ratio": 2.4,
                "topk_overlap": 0.76,
                "regime_split_passed": True,
                "runtime_speedup_pct": 12.0,
            }
        },
        generated_at="2026-05-17T13:45:00Z",
    )

    report = asyncio.run(build_postmarket_report(req))

    assert report["schema_version"] == "paper-challenger-postmarket-report-v1"
    assert report["generated_at"] == "2026-05-17T13:45:00Z"
    assert report["evaluated_count"] == 1
    assert report["promotion_packets"][0]["decision"] == "PROMOTE_TO_PAPER_PRIMARY"
    assert report["real_trading_effect"] == "none"
