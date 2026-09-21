export interface StrategyAbTag {
  schema_version: 'strategy-ab-price-threehead-exo-mlp-v1'
  experiment_id: string
  baseline_primary?: { role: 'A'; recipe: 'price_timexer_three_head'; bundle_checksum: string; l3_checksum: string }
  role: 'A' | 'B'
  recipe: 'price_timexer_three_head' | 'exo137_timexer_three_head_scalar_ev_mlp'
  fee_terms: { discount_factor: 0.25; minimum_net_commission: 20; nominal_next_month_day: 10;
    cash_credit: 'confirmed_receipt_only'; tax_and_slippage_rebated: false }
}

export function strategyAbTag(value: unknown): StrategyAbTag | undefined {
  if (value == null) return undefined
  const tag = typeof value === 'string' ? JSON.parse(value) : value
  if (tag.schema_version !== 'strategy-ab-price-threehead-exo-mlp-v1'
    || !/^[a-f0-9]{64}$/.test(tag.experiment_id)
    || !['A', 'B'].includes(tag.role)
    || tag.recipe !== (tag.role === 'A' ? 'price_timexer_three_head' : 'exo137_timexer_three_head_scalar_ev_mlp')
    || tag.fee_terms?.discount_factor !== .25 || tag.fee_terms.minimum_net_commission !== 20
    || tag.fee_terms.nominal_next_month_day !== 10 || tag.fee_terms.cash_credit !== 'confirmed_receipt_only'
    || tag.fee_terms.tax_and_slippage_rebated !== false) throw Error('strategy_ab_identity_invalid')
  if (tag.baseline_primary != null) {
    const primary = tag.baseline_primary
    if (tag.role !== 'B' || primary.role !== 'A' || primary.recipe !== 'price_timexer_three_head'
      || !/^[a-f0-9]{64}$/.test(primary.bundle_checksum) || !/^[a-f0-9]{64}$/.test(primary.l3_checksum))
      throw Error('strategy_ab_primary_baseline_invalid')
  }
  return tag
}
