import assert from 'node:assert/strict'
import { strategyAbTag } from './strategyAbContract'
const legacy = {schema_version:'strategy-b-exo-tabpack-paper-v1',role:'B',
  recipe:'exo137_timexer_three_head_scalar_ev_tabpack',experiment_id:'a'.repeat(64),
  fee_terms:{discount_factor:.25,minimum_net_commission:20,nominal_next_month_day:10,
    cash_credit:'confirmed_receipt_only',tax_and_slippage_rebated:false}}
assert.deepEqual(strategyAbTag(legacy),legacy)
const current = {...legacy,recipe:'exo131_timexer_three_head_scalar_ev_tabpack',timexer_variant:'exo131'}
assert.deepEqual(strategyAbTag(current),current)
for (const change of [{recipe:legacy.recipe},{timexer_variant:null},{role:'A'},
  {timexer_variant:'exo137'},{schema_version:'strategy-b-exo-full-mlp-median-paper-v1'}]) {
  assert.throws(()=>strategyAbTag({...current,...change}),/identity_invalid/)
}
console.log('strategyAbExo131 tests passed')
