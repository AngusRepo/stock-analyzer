import { lazy, Suspense } from 'react'
import { Route, Switch } from 'wouter'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import MarketHomePage from './pages/MarketHomePage'
import Unauthorized from './pages/Unauthorized'

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
          <Suspense fallback={<PageLoader label="Bot Dashboard" />}>
            <BotDashboard />
          </Suspense>
        </Route>

        <Route path="/pipeline">
          <Suspense fallback={<PageLoader label="Pipeline" />}>
            <PipelinePage />
          </Suspense>
        </Route>

        <Route path="/scheduler">
          <Suspense fallback={<PageLoader label="Scheduler" />}>
            <SchedulerPage />
          </Suspense>
        </Route>

        <Route path="/model-pool">
          <Suspense fallback={<PageLoader label="Model Pool" />}>
            <ModelPoolPage />
          </Suspense>
        </Route>

        <Route path="/data-quality">
          <Suspense fallback={<PageLoader label="Data Quality" />}>
            <DataQualityPage />
          </Suspense>
        </Route>

        <Route path="/strategy-lab">
          <Suspense fallback={<PageLoader label="Strategy Lab" />}>
            <StrategyLabPage />
          </Suspense>
        </Route>

        <Route path="/obs">
          <Suspense fallback={<PageLoader label="OBS" />}>
            <ObservabilityPage />
          </Suspense>
        </Route>

        <Route component={MarketHomePage} />
      </Switch>
    </ErrorBoundary>
  )
}
