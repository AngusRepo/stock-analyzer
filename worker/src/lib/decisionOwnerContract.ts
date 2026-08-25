export type SelectionSignalOwner = 'score_v2_formal_ml'
export type ExpectedReturnDecisionOwner = 'l4_alpha_ev' | 'allocator_ev_fusion' | null
export type AllocationUtilityOwner = 'expected_return_owner' | 'formal_ml_buy_admission'
export type ExecutionDecisionOwner = 'allocator_opb_policy'
export type ExpectedReturnActionGate = 'expected_return_owner' | 'selection_signal_owner'

export interface DecisionOwnerContract {
  schema_version: 'decision-owner-contract-v3'
  selection_signal_owner: SelectionSignalOwner
  expected_return_owner: ExpectedReturnDecisionOwner
  allocation_utility_owner: AllocationUtilityOwner
  execution_owner: ExecutionDecisionOwner
  execution_scope: 'recommendation_allocation_only_no_order_submission'
  action_gate: ExpectedReturnActionGate
}

export function resolveDecisionOwnerContract(
  expectedReturnOwner: ExpectedReturnDecisionOwner,
): DecisionOwnerContract {
  return {
    schema_version: 'decision-owner-contract-v3',
    selection_signal_owner: 'score_v2_formal_ml',
    expected_return_owner: expectedReturnOwner,
    allocation_utility_owner: expectedReturnOwner ? 'expected_return_owner' : 'formal_ml_buy_admission',
    execution_owner: 'allocator_opb_policy',
    execution_scope: 'recommendation_allocation_only_no_order_submission',
    action_gate: expectedReturnOwner ? 'expected_return_owner' : 'selection_signal_owner',
  }
}
