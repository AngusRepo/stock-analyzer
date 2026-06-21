import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from strategy_mining_job_main import _deduped_finlab_confirm


def test_finlab_confirm_dedupes_exact_factor_sets_before_backtest_persist():
    report = {
        "rows": [
            {
                "candidate_id": "pymoo_nsga3_novelty_0260",
                "factor_ids": ["l1_brokerNetAmount5d", "tech_sar", "mom_9m"],
            },
            {
                "candidate_id": "pymoo_nsga3_novelty_0108",
                "factor_ids": ["mom_9m", "tech_sar", "l1_brokerNetAmount5d"],
            },
            {
                "candidate_id": "pymoo_nsga3_novelty_0019",
                "factor_ids": ["l1_sectorFlowCore", "vwap_bias"],
            },
        ],
        "finlab_confirm": [
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0260",
                "monthly_sharpe": 1.28,
                "cagr": 0.46,
                "calmar": 1.47,
            },
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0108",
                "monthly_sharpe": 1.26,
                "cagr": 0.46,
                "calmar": 1.47,
            },
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0019",
                "monthly_sharpe": 1.29,
                "cagr": 0.53,
                "calmar": 2.19,
            },
        ],
    }

    deduped = _deduped_finlab_confirm(report)
    ids = {row["id"] for row in deduped}

    assert ids == {
        "alpha_miner_pymoo_nsga3_novelty_0260",
        "alpha_miner_pymoo_nsga3_novelty_0019",
    }
