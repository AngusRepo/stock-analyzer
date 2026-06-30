from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "output" / "strategy_promotion_preflight"


def _variant(
    *,
    strategy_id: str,
    name: str,
    variant_id: str,
    thresholds: dict[str, Any],
    thesis: str,
) -> dict[str, Any]:
    return {
        "id": strategy_id,
        "version": "strategy-spec-v1",
        "name": name,
        "status": "active",
        "owner": "strategy",
        "familyId": "TREND_QUALITY_BREAKOUT_FUSED",
        "variantId": variant_id,
        "ownerType": "strategy",
        "promotionStatus": "research_only_local_candidate",
        "alphaBucket": "trend_following",
        "supportedRegimes": ["bull", "sideways", "volatile"],
        "thesis": thesis,
        "thresholds": thresholds,
        "candidatePolicy": {
            "poolQuota": 18,
            "costBudget": 20,
            "evidenceRequirements": [
                "fused_source:alphabuilders_multifactor_revenue_quality_momentum_v1",
                "fused_source:breakout_vol_expansion_seed_v1",
                "fused_source:trend_following_seed_v1",
                "local_variant_backtest_required",
            ],
            "maxMlShare": 0.26,
        },
        "riskNotes": [
            "Local fused variant only; not written to remote D1 and not a trading instruction.",
            "Selected variant must pass factor preflight, recent5 select0 gate, OOS, cost stress, and active12 local closure.",
        ],
        "createdBy": "codex_fused_variant_local_closure",
    }


def build_variants() -> list[dict[str, Any]]:
    return [
        _variant(
            strategy_id="trend_quality_breakout_fused_weighted_score_v1",
            name="Trend quality breakout fused weighted score",
            variant_id="weighted_score",
            thesis="Blend trend breadth, breakout volume, and revenue momentum into a single weighted score gate.",
            thresholds={
                "minPrice": 10,
                "dsl": {
                    "any": [
                        {"signal": "factorSignals.monthlyRevenueYoY", "op": ">=", "value": 0},
                        {"signal": "technicalIndicators.macdHist", "op": ">=", "value": 0},
                        {"signal": "technicalIndicators.squeezeRelease", "op": ">=", "value": 1},
                    ]
                },
                "featureRefs": {
                    "weightedScore": {
                        "min": 0.58,
                        "terms": [
                            {"featureRef": "l1_closeAboveMa60Pct", "signal": "factorSignals.finlabCsCloseAboveMa60PctRank", "weight": 0.20},
                            {"featureRef": "l1_volumeExpansion20", "signal": "factorSignals.finlabCsVolumeExpansion20Rank", "weight": 0.20},
                            {"featureRef": "l1_return20d", "signal": "factorSignals.finlabCsReturn20dRank", "weight": 0.16},
                            {"featureRef": "l1_bbBandwidthPct", "signal": "factorSignals.finlabCsBbBandwidthPctRank", "weight": 0.14},
                            {"featureRef": "l1_monthlyRevenueYoY", "signal": "factorSignals.finlabCsMonthlyRevenueYoYRank", "weight": 0.16},
                            {"featureRef": "l1_monthlyRevenueMoM", "signal": "factorSignals.finlabCsMonthlyRevenueMoMRank", "weight": 0.14},
                        ],
                    }
                },
            },
        ),
        _variant(
            strategy_id="trend_quality_breakout_fused_trend_gate_quality_rank_v1",
            name="Trend quality breakout fused trend gate quality rank",
            variant_id="trend_gate_quality_rank",
            thesis="Require trend confirmation first, then admit higher-quality revenue and volume-ranked names.",
            thresholds={
                "minPrice": 10,
                "dsl": {
                    "all": [
                        {"signal": "technicalIndicators.macdHist", "op": ">=", "value": 0},
                        {"signal": "technicalIndicators.adx14", "op": ">=", "value": 18},
                    ],
                    "any": [
                        {"signal": "factorSignals.monthlyRevenueYoY", "op": ">=", "value": 0},
                        {"signal": "factorSignals.monthlyRevenueMoM", "op": ">=", "value": 0},
                    ],
                },
                "featureRefs": {
                    "any": [
                        {"featureRef": "l1_volumeExpansion20", "signal": "factorSignals.finlabCsVolumeExpansion20Rank", "op": ">=", "value": 0.62},
                        {"featureRef": "l1_return20d", "signal": "factorSignals.finlabCsReturn20dRank", "op": ">=", "value": 0.62},
                        {"featureRef": "l1_closeAboveMa60Pct", "signal": "factorSignals.finlabCsCloseAboveMa60PctRank", "op": ">=", "value": 0.58},
                    ]
                },
            },
        ),
        _variant(
            strategy_id="trend_quality_breakout_fused_breakout_confirmed_quality_trend_v1",
            name="Trend quality breakout fused breakout confirmed quality trend",
            variant_id="breakout_confirmed_quality_trend",
            thesis="Favor confirmed breakout expansion while keeping a revenue/trend quality backstop.",
            thresholds={
                "minPrice": 10,
                "dsl": {
                    "any": [
                        {"signal": "technicalIndicators.squeezeRelease", "op": ">=", "value": 1},
                        {"signal": "technicalIndicators.squeezeMomentum", "op": ">=", "value": 0},
                        {"signal": "technicalIndicators.bestOrderBlockStrength", "op": ">=", "value": 0.45},
                    ]
                },
                "featureRefs": {
                    "all": [
                        {"featureRef": "l1_volumeExpansion20", "signal": "factorSignals.finlabCsVolumeExpansion20Rank", "op": ">=", "value": 0.55},
                    ],
                    "any": [
                        {"featureRef": "l1_bbBandwidthPct", "signal": "factorSignals.finlabCsBbBandwidthPctRank", "op": ">=", "value": 0.55},
                        {"featureRef": "l1_return20d", "signal": "factorSignals.finlabCsReturn20dRank", "op": ">=", "value": 0.55},
                        {"featureRef": "l1_closeAboveMa60Pct", "signal": "factorSignals.finlabCsCloseAboveMa60PctRank", "op": ">=", "value": 0.52},
                    ],
                },
            },
        ),
    ]


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    variants = build_variants()
    variants_path = OUT_DIR / "trend_quality_breakout_fused_variants.json"
    summary_path = OUT_DIR / "trend_quality_breakout_fused_variants_summary.json"
    variants_path.write_text(json.dumps(variants, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {
        "schema_version": "stockvision-fused-strategy-variants-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decision_effect": "local_research_only",
        "variant_count": len(variants),
        "variant_ids": [row["id"] for row in variants],
        "json": str(variants_path.relative_to(ROOT).as_posix()),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
