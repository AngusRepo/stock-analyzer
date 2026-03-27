/**
 * hooks.ts — React Query hooks replacing all tRPC hooks
 * Usage: const { data } = useStockPrices(stockId)
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { stocksApi, marketApi, llmApi, watchlistApi, alertsApi } from '../lib/api'

// ─── Market ───────────────────────────────────────────────────────────────────
export const useMarketIndices = () =>
  useQuery({ queryKey: ['market', 'indices'], queryFn: marketApi.indices, refetchInterval: 5 * 60 * 1000, staleTime: 3 * 60 * 1000 })

// ─── Stocks ───────────────────────────────────────────────────────────────────
export const useStocks      = () => useQuery({ queryKey: ['stocks'], queryFn: stocksApi.list })
export const useStock       = (id: number | null) => useQuery({ queryKey: ['stock', id], queryFn: () => stocksApi.get(id!), enabled: !!id })
export const useStockSearch = (q: string) => useQuery({ queryKey: ['stocks', 'search', q], queryFn: () => stocksApi.search(q), enabled: q.length > 0 })

export const useAddStock = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: stocksApi.add, onSuccess: () => qc.invalidateQueries({ queryKey: ['stocks'] }) })
}
export const useRemoveStock = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: stocksApi.remove, onSuccess: () => qc.invalidateQueries({ queryKey: ['stocks'] }) })
}
export const useRefreshStock = () =>
  useMutation({ mutationFn: stocksApi.refresh })

// ─── Stock Data ───────────────────────────────────────────────────────────────
export const useStockPrices      = (id: number | null, days = 365) => useQuery({ queryKey: ['prices', id, days],      queryFn: () => stocksApi.prices(id!, days),        enabled: !!id })
export const useStockIndicators  = (id: number | null, days = 365) => useQuery({ queryKey: ['indicators', id, days],  queryFn: () => stocksApi.indicators(id!, days),    enabled: !!id })
export const useStockFinancials  = (id: number | null, limit = 12) => useQuery({ queryKey: ['financials', id, limit], queryFn: () => stocksApi.financials(id!, limit),   enabled: !!id })
export const useStockChips       = (id: number | null, days = 60)  => useQuery({ queryKey: ['chips', id, days],       queryFn: () => stocksApi.chips(id!, days),         enabled: !!id })
export const useStockNews        = (id: number | null, days = 30)  => useQuery({ queryKey: ['news', id, days],        queryFn: () => stocksApi.news(id!, days),          enabled: !!id })
export const useStockPredictions = (id: number | null)             => useQuery({ queryKey: ['predictions', id],       queryFn: () => stocksApi.predictions(id!),         enabled: !!id })
export const useStockFactors     = (id: number | null)             => useQuery({ queryKey: ['factors', id],           queryFn: () => stocksApi.factors(id!),             enabled: !!id })
export const useStockRisk        = (id: number | null, period = '1y') => useQuery({ queryKey: ['risk', id, period],  queryFn: () => stocksApi.risk(id!, period),        enabled: !!id })

// ─── LLM ─────────────────────────────────────────────────────────────────────
export const useTechnicalAnalysis = () => useMutation({ mutationFn: llmApi.technicalAnalysis })
export const useAnalystSummary    = () => useMutation({ mutationFn: llmApi.analystSummary })
export const useAskQuestion       = () => useMutation({ mutationFn: ({ stockId, question, history }: { stockId: number; question: string; history?: any[] }) => llmApi.ask(stockId, question, history) })

// ─── Watchlist ────────────────────────────────────────────────────────────────
export const useWatchlistItem = (stockId: number | null) => useQuery({ queryKey: ['watchlist', stockId], queryFn: () => watchlistApi.get(stockId!), enabled: !!stockId })
export const useUpsertWatchlist = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ stockId, ...body }: any) => watchlistApi.upsert(stockId, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ['watchlist', vars.stockId] })
  })
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
export const useAlerts = () => useQuery({ queryKey: ['alerts'], queryFn: alertsApi.list })
export const useAddAlert = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: alertsApi.add, onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) })
}
export const useRemoveAlert = () => {
  const qc = useQueryClient()
  return useMutation({ mutationFn: alertsApi.remove, onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) })
}
