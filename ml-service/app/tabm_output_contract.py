"""Versioned TabM member training and rank prediction semantics."""
from __future__ import annotations

MEMBER_CONTRACT = "tabm-member-smoothl1-mean-sigmoid-v2"
LEGACY_CONTRACT = "tabm-mean-logit-smoothl1-v1"


def member_logits(output):
    if isinstance(output, (tuple, list)):
        output = output[0]
    if output.ndim != 3 or output.shape[-1] != 1:
        raise ValueError("tabm_member_output_requires_batch_members_single_target")
    return output.squeeze(-1)


def member_loss(output, target):
    import torch
    import torch.nn.functional as F
    prediction = torch.sigmoid(member_logits(output))
    return F.smooth_l1_loss(prediction, target.reshape(-1, 1).expand_as(prediction))


def member_rank_prediction(output):
    import torch
    return torch.sigmoid(member_logits(output)).mean(dim=1)


def validate_output_contract(metadata):
    contract = metadata.get("output_contract") or LEGACY_CONTRACT
    if contract not in {MEMBER_CONTRACT, LEGACY_CONTRACT}:
        raise ValueError("tabm_output_contract_unknown")
    if metadata.get("artifact_schema") == "torch_tabm_ranker_v2" and contract != MEMBER_CONTRACT:
        raise ValueError("tabm_v2_requires_member_output_contract")
    return contract
