import { Redirect } from 'wouter'

export const LEGACY_STOCK_REPORT_REDIRECT_TARGET = '/'

export default function LegacyStockReportRedirectPage() {
  return <Redirect to={LEGACY_STOCK_REPORT_REDIRECT_TARGET} replace />
}
