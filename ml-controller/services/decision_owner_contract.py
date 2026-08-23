"""Single decision-owner contract shared by pipeline and recommendation boundaries."""

from __future__ import annotations

from typing import Literal, TypedDict

ExpectedReturnOwner = Literal["l4_alpha_ev", "allocator_ev_fusion"]


class DecisionOwnerContract(TypedDict):
    schema_version: Literal["decision-owner-contract-v1"]
    selection_signal_owner: Literal["score_v2_formal_ml"]
    expected_return_owner: ExpectedReturnOwner | None
    execution_owner: Literal["allocator_opb_policy", "none_fail_closed"]
    action_gate: Literal["expected_return_owner", "canonical_l4_required"]


def resolve_decision_owner_contract(
    expected_return_owner: ExpectedReturnOwner | None,
) -> DecisionOwnerContract:
    return {
        "schema_version": "decision-owner-contract-v1",
        "selection_signal_owner": "score_v2_formal_ml",
        "expected_return_owner": expected_return_owner,
        "execution_owner": (
            "allocator_opb_policy"
            if expected_return_owner is not None
            else "none_fail_closed"
        ),
        "action_gate": (
            "expected_return_owner"
            if expected_return_owner is not None
            else "canonical_l4_required"
        ),
    }
