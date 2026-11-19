/**
 * Post-close steps disabled by design (Wei, 2026-11-18): serving-pointer promotion and the strategy
 * policy update belong to the R33 monthly promotion. The gates that keep them from running are
 * unchanged; this token only names the skip in receipts and scheduler status, so it reads as the
 * intended no-op rather than a daily "should have run" incident.
 */
export const R33_MONTHLY_PROMOTION_DESIGN_DISABLED = 'disabled_by_design:r33_monthly_promotion_owner'

/** A skip receipt for the step itself leads with the token; a summary that merely mentions it does not count. */
export function isDesignDisabledSummary(summary?: string | null): boolean {
  return (summary ?? '').trimStart().startsWith(R33_MONTHLY_PROMOTION_DESIGN_DISABLED)
}
