"""Strategy replacement evidence is evaluated outside the formal night."""
import inspect


def test_formal_night_never_captures_atomic_inputs():
    from graphs import daily_pipeline_v2 as graph
    assert 'capture_atomic_inputs' not in graph.build_graph().get_graph().nodes
    for runner in (graph.run_pipeline_v2, graph.run_pipeline_v2_until_modal_prediction_spawn):
        assert 'node_capture_atomic_inputs' not in inspect.getsource(runner)
