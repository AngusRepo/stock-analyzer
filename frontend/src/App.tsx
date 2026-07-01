import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Switch } from 'wouter'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import MarketHomePage from './pages/MarketHomePage'
import Unauthorized from './pages/Unauthorized'
import { useAuth } from './_core/hooks/useAuth'
import { isPrimaryAdminUser } from './lib/adminAccess'

const BotDashboard = lazy(() => import('./pages/BotDashboard'))
const StockReportPage = lazy(() => import('./pages/StockReportPage'))
const PipelinePage = lazy(() => import('./pages/PipelinePage'))
const SchedulerPage = lazy(() => import('./pages/SchedulerPage'))
const ModelPoolPage = lazy(() => import('./pages/ModelPoolPage'))
const DataQualityPage = lazy(() => import('./pages/DataQualityPage'))
const StrategyLabPage = lazy(() => import('./pages/StrategyLabPage'))
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage'))

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
      <Switch>
        <Route path="/" component={MarketHomePage} />
        <Route path="/dashboard" component={MarketHomePage} />
        <Route path="/home" component={MarketHomePage} />
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

        <Route component={MarketHomePage} />
      </Switch>
    </ErrorBoundary>
  )
}
