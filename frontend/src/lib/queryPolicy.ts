import type { QueryClient, QueryKey } from '@tanstack/react-query'
import {
  dataQualityApi,
  deployGateApi,
  marketApi,
  modelPoolApi,
  observabilityApi,
  opsApi,
  paperApi,
  recommendationsApi,
  schedulerApi,
  systemApi,
} from '@/lib/api'
import { splitRecommendationLanes } from '@/lib/recommendationLanes'

export const queryTtl = {
  realtime: 30_000,
  intraday: 60_000,
  dashboard: 5 * 60_000,
  dailyDecision: 30 * 60_000,
  reference: 60 * 60_000,
} as const

export const defaultQueryOptions = {
  queries: {
    retry: 1,
    staleTime: 2 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    structuralSharing: true,
  },
}

export function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export const recommendationDailyKey = (date = twToday()) =>
  ['recommendations', 'daily', date, 'card-view-v2'] as const

export function selectRecommendationLanes<T extends Record<string, any>>(payload: any) {
  return {
    payload,
    ...splitRecommendationLanes<T>(payload),
  }
}

type PrefetchSpec = {
  queryKey: QueryKey
  queryFn: () => Promise<unknown>
  staleTime?: number
}

function prefetchMany(queryClient: QueryClient, specs: PrefetchSpec[]) {
  for (const spec of specs) {
    void queryClient.prefetchQuery({
      queryKey: spec.queryKey,
      queryFn: spec.queryFn,
      staleTime: spec.staleTime,
    })
  }
}

export function prefetchWorkstationRoute(
  queryClient: QueryClient,
  href: string,
  opts: { isAuthenticated?: boolean; isAdmin?: boolean } = {},
) {
  const date = twToday()

  if (href === '/') {
    prefetchMany(queryClient, [
      { queryKey: ['market', 'risk', 'public-home'], queryFn: marketApi.risk, staleTime: queryTtl.intraday },
      { queryKey: ['recommendations', 'sector-flow', 'theme', 'public-home', date], queryFn: () => recommendationsApi.sectorFlow(undefined, 'theme'), staleTime: queryTtl.dailyDecision },
      { queryKey: ['recommendations', 'daily-report', 'public-home', date], queryFn: () => recommendationsApi.dailyReport(), staleTime: queryTtl.dailyDecision },
    ])
    return
  }

  if (href.startsWith('/stock/')) {
    prefetchMany(queryClient, [
      { queryKey: ['market', 'indices'], queryFn: marketApi.indices, staleTime: queryTtl.dashboard },
      { queryKey: recommendationDailyKey(date), queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }), staleTime: queryTtl.intraday },
    ])
    return
  }

  if (href === '/bot' && opts.isAuthenticated) {
    prefetchMany(queryClient, [
      { queryKey: ['paper', 'account'], queryFn: paperApi.account, staleTime: queryTtl.intraday },
      { queryKey: ['paper', 'pending-buys'], queryFn: paperApi.pendingBuys, staleTime: queryTtl.dashboard },
      { queryKey: recommendationDailyKey(date), queryFn: () => recommendationsApi.daily(undefined, { view: 'card' }), staleTime: queryTtl.intraday },
    ])
    return
  }

  if (href === '/model-pool/inspector' && opts.isAdmin) {
    prefetchMany(queryClient, [
      { queryKey: ['model-pool', 'artifactRegistry', 'inspector'], queryFn: () => modelPoolApi.artifactRegistry(500), staleTime: queryTtl.intraday },
    ])
    return
  }

  if (href === '/obs' && opts.isAdmin) {
    prefetchMany(queryClient, [
      { queryKey: ['obs', 'scheduler'], queryFn: schedulerApi.status, staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'data-quality'], queryFn: () => dataQualityApi.status(), staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'deploy-gate'], queryFn: () => deployGateApi.predeploy(), staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'events'], queryFn: () => observabilityApi.events(), staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'drilldown'], queryFn: () => observabilityApi.drilldown(), staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'model-pool-lineage'], queryFn: modelPoolApi.lineage, staleTime: queryTtl.intraday },
      { queryKey: ['obs', 'system'], queryFn: systemApi.status, staleTime: queryTtl.realtime },
      { queryKey: ['obs', 'resource-audit'], queryFn: opsApi.resourceAudit, staleTime: 2 * queryTtl.intraday },
    ])
  }
}
