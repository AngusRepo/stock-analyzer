const routeModules = {
  marketHome: () => import('@/pages/MarketHomePage'),
  dashboard: () => import('@/pages/Dashboard'),
  unauthorized: () => import('@/pages/Unauthorized'),
  bot: () => import('@/pages/BotDashboard'),
  stockReport: () => import('@/pages/StockReportPage'),
  pipeline: () => import('@/pages/PipelinePage'),
  scheduler: () => import('@/pages/SchedulerPage'),
  modelPool: () => import('@/pages/ModelPoolPage'),
  notFound: () => import('@/pages/NotFound'),
  dataQuality: () => import('@/pages/DataQualityPage'),
  strategyLab: () => import('@/pages/StrategyLearningPage'),
  observability: () => import('@/pages/ObservabilityPage'),
} as const

export const loadMarketHomePage = routeModules.marketHome
export const loadDashboard = routeModules.dashboard
export const loadUnauthorized = routeModules.unauthorized
export const loadBotDashboard = routeModules.bot
export const loadStockReportPage = routeModules.stockReport
export const loadPipelinePage = routeModules.pipeline
export const loadSchedulerPage = routeModules.scheduler
export const loadModelPoolPage = routeModules.modelPool
export const loadNotFound = routeModules.notFound
export const loadDataQualityPage = routeModules.dataQuality
export const loadStrategyLabPage = routeModules.strategyLab
export const loadObservabilityPage = routeModules.observability

function loaderForHref(href: string): (() => Promise<unknown>) | undefined {
  if (href === '/') return routeModules.marketHome
  if (href.startsWith('/stock/')) return routeModules.dashboard
  if (href.startsWith('/report/')) return routeModules.stockReport
  if (href === '/unauthorized') return routeModules.unauthorized
  if (href === '/bot') return routeModules.bot
  if (href === '/pipeline') return routeModules.pipeline
  if (href === '/scheduler') return routeModules.scheduler
  if (href === '/model-pool') return routeModules.modelPool
  if (href === '/data-quality') return routeModules.dataQuality
  if (href === '/strategy-lab') return routeModules.strategyLab
  if (href === '/obs') return routeModules.observability
  return undefined
}

export function preloadRouteModule(href: string) {
  const loader = loaderForHref(href)
  if (loader) void loader().catch(() => undefined)
}
