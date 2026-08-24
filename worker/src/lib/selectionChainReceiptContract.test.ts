import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SELECTION_CHAIN_RECEIPT_VERSION,
  buildSelectionChainReceiptV1,
} from './selectionReferenceEvidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const fullCandidate = buildSelectionChainReceiptV1({
  strategySelected: 1,
  mlScore: 0.72,
  mlVoteSummary: { models: 8 },
  signal: 'STRONG_BUY',
  hasBuySignal: 1,
  eligibleForMl: 1,
  eligibleForPendingBuy: 1,
  alphaAllocation: {
    selected: true,
    expected_return_owner: 'allocator_ev_fusion',
    expected_return: 0.018,
    l4_alpha_ev: { status: 'verified', production_eligible: true },
    allocator_ev_fusion: {
      status: 'verified',
      primary_expected_return_allowed: true,
    },
  },
})
assert(fullCandidate.version === SELECTION_CHAIN_RECEIPT_VERSION, 'selection receipt must expose the canonical contract version')
assert(fullCandidate.stages.l15_router_selected, 'selection receipt must preserve L1.5 route admission')
assert(fullCandidate.stages.ml_evaluated, 'selection receipt must distinguish ML evaluation from ML selection')
assert(fullCandidate.stages.l4_feature_available && fullCandidate.stages.l4_production_eligible, 'L4 availability and production eligibility must be separate facts')
assert(fullCandidate.stages.primary_expected_return_available, 'formal fusion owner must expose primary expected-return availability')
assert(fullCandidate.stages.allocator_selected && fullCandidate.stages.pending_buy_candidate, 'pending buy requires allocator selection and an executable buy signal')
assert(fullCandidate.terminal.selection_stage === 'pending_buy_candidate' && fullCandidate.terminal.rejection_reason == null, 'complete chain must terminate as pending-buy candidate without rejection')

const routeOnly = buildSelectionChainReceiptV1({
  strategySelected: 1,
  eligibleForMl: 1,
  eligibleForPendingBuy: 1,
})
assert(routeOnly.terminal.selection_stage === 'l15_router_selected', 'route admission must not collapse back to L1 observe when downstream evidence is absent')
assert(routeOnly.terminal.rejection_reason === 'route_selected_without_ml_evaluation', 'missing downstream ML receipt must remain explicit')

const abstention = buildSelectionChainReceiptV1({
  strategySelected: 1,
  mlScore: 0.61,
  mlVoteSummary: { models: 8 },
  signal: 'HOLD',
  eligibleForMl: 1,
  eligibleForPendingBuy: 1,
  alphaAllocation: {
    selected: false,
    expected_return_owner: 'risk_abstention',
    expected_return: null,
  },
})
assert(abstention.stages.ml_evaluated, 'abstention receipt must preserve completed ML evaluation')
assert(!abstention.stages.primary_expected_return_available, 'null expected return and risk abstention must never masquerade as primary expected-return availability')
assert(abstention.terminal.selection_stage === 'ml_evaluated_waiting_expected_return', 'risk abstention must expose the exact stopped stage')

const inconsistentBuy = buildSelectionChainReceiptV1({
  strategySelected: 1,
  mlScore: 0.8,
  mlVoteSummary: { models: 8 },
  signal: 'BUY',
  hasBuySignal: 1,
  eligibleForMl: 1,
  eligibleForPendingBuy: 1,
  alphaAllocation: { selected: false, expected_return_owner: 'allocator_ev_fusion' },
})
assert(!inconsistentBuy.stages.pending_buy_candidate, 'buy signal without allocator selection must fail closed before pending buy')
assert(inconsistentBuy.terminal.rejection_reason === 'buy_signal_without_allocator_selection', 'cross-layer integrity violation must be explicit')

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, 'selectionReferenceEvidence.ts'), 'utf8')
const schema = fs.readFileSync(path.join(here, '../../domain-schemas/learning.sql'), 'utf8')
const migration = fs.readFileSync(path.join(here, '../../domain-migrations/learning/0024_selection_chain_receipt_semantics.sql'), 'utf8')
assert(!source.includes('SET ml_selected=?, l4_selected=?'), 'reconciliation must stop writing evaluated/available facts into legacy selected aliases')
for (const column of [
  'ml_evaluated',
  'l4_feature_available',
  'l4_production_eligible',
  'fusion_feature_available',
  'primary_expected_return_available',
  'pending_buy_eligible',
  'pending_buy_candidate',
  'selection_chain_receipt_json',
]) {
  assert(schema.includes(column), `Learning schema must include ${column}`)
  assert(migration.includes(column), `Learning migration must include ${column}`)
}

console.log('selection chain receipt contract tests passed')
