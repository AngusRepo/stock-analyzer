import { apiGet } from './apiClient'
import type { PairedNavShadowReadModel } from './pipelineMaturityContract'
import type { NavComparisonDetail } from './navTradingRoom'
export const navTradingRoomApi = {
  comparisons: (date?: string) => apiGet<PairedNavShadowReadModel>(`/dashboard/v4/nav/comparisons${date ? `?date=${date}` : ''}`),
  detail: (pair: string, date?: string) => apiGet<NavComparisonDetail>(`/dashboard/v4/nav/comparisons/${encodeURIComponent(pair)}${date ? `?date=${date}` : ''}`),
}
