export interface CircuitAdjustedSingleNameCapInput {
  configuredSingleNameCap: number
  circuitBaselinePositionPct: number
  circuitEffectivePositionPct: number
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * The R2 circuit field is a scaling gauge (8% normal, 4% high-vol), while the
 * five-slot allocator owns the actual per-name NAV cap. Converting the gauge
 * to a ratio preserves the continuous total-exposure curve and avoids turning
 * the legacy 8% baseline into an unintended absolute five-slot cap.
 */
export function resolveCircuitAdjustedSingleNameCap(
  input: CircuitAdjustedSingleNameCapInput,
): number {
  const configuredCap = Math.min(1, finiteNonNegative(input.configuredSingleNameCap))
  const baseline = finiteNonNegative(input.circuitBaselinePositionPct)
  const effective = finiteNonNegative(input.circuitEffectivePositionPct)
  if (configuredCap <= 0 || baseline <= 0 || effective <= 0) return 0
  const circuitScale = Math.min(1, effective / baseline)
  return configuredCap * circuitScale
}
