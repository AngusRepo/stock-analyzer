export type SelectionSignalOwner = 'score_v2_formal_ml'
export type ExpectedReturnDecisionOwner = 'l4_alpha_ev' | 'allocator_ev_fusion' | null
export type ExecutionDecisionOwner = 'allocator_opb_policy' | 'none_fail_closed'
export type ExpectedReturnActionGate = 'expected_return_owner' | 'canonical_l4_required'

export interface DecisionOwnerContract {
  schema_version: 'decision-owner-contract-v1'
  selection_signal_owner: SelectionSignalOwner
  expected_return_owner: ExpectedReturnDecisionOwner
  execution_owner: ExecutionDecisionOwner
  action_gate: ExpectedReturnActionGate
}

export function resolveDecisionOwnerContract(
  expectedReturnOwner: ExpectedReturnDecisionOwner,
): DecisionOwnerContract {
  return {
    schema_version: 'decision-owner-contract-v1',
    selection_signal_owner: 'score_v2_formal_ml',
    expected_return_owner: expectedReturnOwner,
    execution_owner: expectedReturnOwner ? 'allocator_opb_policy' : 'none_fail_closed',
    action_gate: expectedReturnOwner ? 'expected_return_owner' : 'canonical_l4_required',
  }
}
