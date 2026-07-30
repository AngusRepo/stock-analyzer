import assert from 'node:assert/strict'
import { parseScreenerArtifactInput } from './adminControlRoutes'

const valid = {
  domain: 'strategy_redundancy_oof',
  businessDate: '2026-07-29',
  producerRunId: 'strategy-redundancy-oof-v1-2026-07-29-test',
  retentionClass: 'canonical_model_evidence',
  schemaVersion: 'strategy-redundancy-oof-evidence-v1',
  rowCount: 3,
  payload: {
    schema_version: 'strategy-similarity-evidence-v1',
    status: 'computed',
    source: 'modal_python',
    evidence_only: true,
    production_selector: false,
    production_decision_path: false,
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    strategy_count: 4,
    eligible_oof_pair_count: 3,
    strategy_cluster_id: { s1: 'sc000' },
    pairwise_oof_evidence: { 's1|s2': { eligible: true } },
  },
}

const parsed = parseScreenerArtifactInput(valid)
assert.equal(parsed.domain, 'strategy_redundancy_oof')
assert.equal(parsed.rowCount, 3)
assert.throws(
  () => parseScreenerArtifactInput({
    ...valid,
    payload: { ...valid.payload, production_selector: true },
  }),
  /invalid strategy redundancy OOF artifact payload/,
)
assert.throws(
  () => parseScreenerArtifactInput({ ...valid, domain: 'strategy_redundancy_shadow_unknown' }),
  /artifact domain is not allowed/,
)
