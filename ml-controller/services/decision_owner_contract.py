"""Single decision-owner contract shared by pipeline and recommendation boundaries."""

from __future__ import annotations

from typing import Literal, TypedDict

ExpectedReturnOwner = Literal["l4_alpha_ev", "allocator_ev_fusion"]


class DecisionOwnerContract(TypedDict):
    schema_version: Literal["decision-owner-contract-v2"]
    selection_signal_owner: Literal["score_v2_formal_ml"]
    expected_return_owner: ExpectedReturnOwner | None
    allocation_utility_owner: Literal["expected_return_owner", "score_v2_formal_ml"]
    execution_owner: Literal["allocator_opb_policy"]
    execution_scope: Literal["recommendation_allocation_only_no_order_submission"]
    action_gate: Literal["expected_return_owner", "selection_signal_owner"]


def resolve_decision_owner_contract(
    expected_return_owner: ExpectedReturnOwner | None,
) -> DecisionOwnerContract:
    return {
        "schema_version": "decision-owner-contract-v2",
        "selection_signal_owner": "score_v2_formal_ml",
        "expected_return_owner": expected_return_owner,
        "allocation_utility_owner": (
            "expected_return_owner"
            if expected_return_owner is not None
            else "score_v2_formal_ml"
        ),
        "execution_owner": "allocator_opb_policy",
        "execution_scope": "recommendation_allocation_only_no_order_submission",
        "action_gate": (
            "expected_return_owner"
            if expected_return_owner is not None
            else "selection_signal_owner"
        ),
    }
