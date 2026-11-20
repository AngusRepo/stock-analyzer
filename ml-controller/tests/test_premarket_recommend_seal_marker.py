"""The real recommend node writes learning D1 only after it reports 'seal'."""
import test_paired_nav_l3_candidate as real_node
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner
from services import premarket_pipeline as m


def test_actual_recommend_node_has_no_learning_write_before_seal_marker(prepared, monkeypatch, native_runner):
    db = prepared[0]
    progress, stages, original = {'stage': None}, [], db.writer
    def writer(statements, *args, **kwargs):
        stages.append(progress['stage'])
        return original(statements, *args, **kwargs)
    db.writer = writer
    token = m._recommend_progress.set(progress)
    try:
        real_node.test_actual_daily_node_freezes_matching_model_and_collects_l3_plan(
            prepared, monkeypatch, False, native_runner)
    finally:
        m._recommend_progress.reset(token)
    assert stages and set(stages) == {'seal'}, stages
