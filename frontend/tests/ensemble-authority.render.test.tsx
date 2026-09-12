import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import EnsembleAuthority from '../src/components/model-pool/EnsembleAuthority'
import type { Active8ServingBundleReadModel } from '../src/lib/api'

const bundle: Active8ServingBundleReadModel = {
  status: 'production', production_effect: true, selected_models: [], base_artifacts: {}, blockers: [],
  adoption_basis: 'committed_paired_nav', nav_decision_checksum: 'original-decision',
  qualifications: { schema_version: 'test', promotion_scope: 'ranking',
    ranking: { decision: 'FAIL', blockers: ['ranking_validation_not_passed'] },
    calibration: { decision: 'INSUFFICIENT', scope: 'diagnostic', probability_status: 'diagnostic_only', blockers: [] },
    directional: { decision: 'BLOCKED', allowed_signals: [], signals: {} } },
}
const render = (value?: Active8ServingBundleReadModel) => renderToStaticMarkup(<EnsembleAuthority bundle={value} />)
assert(render(bundle).includes('原始配對 NAV 已核對'))
assert(render(bundle).includes('離線排名診斷：FAIL'))
assert(render(bundle).includes('original-decision'))
assert(!render({ ...bundle, status: 'invalid_bundle', production_effect: false }).includes('原始配對 NAV 已核對'))
assert(!render({ ...bundle, nav_decision_checksum: undefined }).includes('原始配對 NAV 已核對'))
assert(render({ ...bundle, adoption_basis: undefined }).includes('非 NAV 採用'))
assert(render().includes('尚無有效正式 bundle'))
assert(render().includes('尚無資料'))
console.log('Ensemble authority: NAV/diagnostic separation, invalid and missing evidence passed')
