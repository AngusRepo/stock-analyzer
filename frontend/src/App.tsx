import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Switch } from 'wouter'
import ErrorBoundary from './components/ErrorBoundary'
import { useAuth } from './_core/hooks/useAuth'
import { isPrimaryAdminUser } from './lib/adminAccess'
import {
  loadBotDashboard,
  loadDashboard,
  loadDataQualityPage,
  loadMarketHomePage,
  loadModelPoolPage,
  loadNotFound,
  loadObservabilityPage,
  loadPipelinePage,
  loadSchedulerPage,
  loadStockReportPage,
  loadStrategyLabPage,
  loadUnauthorized,
} from './lib/routeModules'

const MarketHomePage = lazy(loadMarketHomePage)
const Dashboard = lazy(loadDashboard)
const Unauthorized = lazy(loadUnauthorized)
const BotDashboard = lazy(loadBotDashboard)
const StockReportPage = lazy(loadStockReportPage)
const PipelinePage = lazy(loadPipelinePage)
const SchedulerPage = lazy(loadSchedulerPage)
const ModelPoolPage = lazy(loadModelPoolPage)
const NotFound = lazy(loadNotFound)
const DataQualityPage = lazy(loadDataQualityPage)
const StrategyLabPage = lazy(loadStrategyLabPage)
const ObservabilityPage = lazy(loadObservabilityPage)

function PageLoader({ label }: { label: string }) {
  return (
    <div className="grid h-screen place-items-center bg-[#090a0d] text-sm text-slate-500">
      Loading {label}...
    </div>
  )
}

function AdminOnly({ children, label }: { children: ReactNode; label: string }) {
  const { user, loading } = useAuth()
  if (loading) return <PageLoader label={label} />
  if (!isPrimaryAdminUser(user)) return <Unauthorized />
  return <>{children}</>
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader label="Page" />}>
        <Switch>
        <Route path="/" component={MarketHomePage} />
        <Route path="/stock/:id" component={Dashboard} />
        <Route path="/unauthorized" component={Unauthorized} />

        <Route path="/report/:symbol">
          <Suspense fallback={<PageLoader label="Report" />}>
            <StockReportPage />
          </Suspense>
        </Route>

        <Route path="/bot">
          <AdminOnly label="Bot Dashboard">
            <Suspense fallback={<PageLoader label="Bot Dashboard" />}>
              <BotDashboard />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/pipeline">
          <AdminOnly label="Pipeline">
            <Suspense fallback={<PageLoader label="Pipeline" />}>
              <PipelinePage />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/scheduler">
          <AdminOnly label="Scheduler">
            <Suspense fallback={<PageLoader label="Scheduler" />}>
              <SchedulerPage />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/model-pool">
          <AdminOnly label="Model Pool">
            <Suspense fallback={<PageLoader label="Model Pool" />}>
              <ModelPoolPage />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/data-quality">
          <AdminOnly label="Data Quality">
            <Suspense fallback={<PageLoader label="Data Quality" />}>
              <DataQualityPage />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/strategy-lab">
          <AdminOnly label="Strategy Lab">
            <Suspense fallback={<PageLoader label="Strategy Lab" />}>
              <StrategyLabPage />
            </Suspense>
          </AdminOnly>
        </Route>

        <Route path="/obs">
          <AdminOnly label="OBS">
            <Suspense fallback={<PageLoader label="OBS" />}>
              <ObservabilityPage />
            </Suspense>
          </AdminOnly>
        </Route>

          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ErrorBoundary>
  )
}
