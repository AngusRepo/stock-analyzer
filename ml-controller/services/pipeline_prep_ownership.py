"""Bounded prep ownership checks shared by Controller and Modal; no polling."""
import logging

PREP_TIMEOUT_SECONDS = 1900
LEGACY_CLAIM_GRACE_SECONDS = PREP_TIMEOUT_SECONDS + 200
MAX_PREP_ATTEMPTS = 3

def modal_prep_call_finished(call_id):
    if not isinstance(call_id, str) or not call_id.startswith('fc-'):
        return False
    import modal
    try:
        graph = modal.FunctionCall.from_id(call_id).get_call_graph()
    except Exception as exc:
        logging.getLogger(__name__).warning('Prep owner observation unavailable: %s', type(exc).__name__)
        return False
    # The wrapper uses spawn(), never map(); absence/foreign/ambiguous inputs
    # cannot authorize takeover. No application result payload is downloaded.
    return (
        len(graph) == 1
        and graph[0].function_call_id == call_id
        and graph[0].function_name == 'prep_universal_batch_event'
        and graph[0].status.name in {'SUCCESS', 'FAILURE', 'INIT_FAILURE', 'TERMINATED', 'TIMEOUT'}
    )
