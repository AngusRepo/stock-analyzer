import { Route, Switch } from 'wouter'
import { lazy, Suspense } from 'react'
import Dashboard from './pages/Dashboard'
import Unauthorized from './pages/Unauthorized'
import ErrorBoundary from './components/ErrorBoundary'

const BotDashboard = lazy(() => import('./pages/BotDashboard'))
const StockReportPage = lazy(() => import('./pages/StockReportPage'))
const PipelinePage = lazy(() => import('./pages/PipelinePage'))
const SchedulerPage = lazy(() => import('./pages/SchedulerPage'))
const ModelPoolPage = lazy(() => import('./pages/ModelPoolPage'))
const DataQualityPage = lazy(() => import('./pages/DataQualityPage'))
const StrategyLabPage = lazy(() => import('./pages/StrategyLabPage'))
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage'))
const DailyFocusPrototypePage = lazy(() => import('./pages/DailyFocusPrototypePage'))

function PageLoader({ label }: { label: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
      Loading {label}...
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/dashboard" component={Dashboard} />
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
        <Route path="/preview/daily-focus">
          <Suspense fallback={<PageLoader label="Daily Focus Preview" />}>
            <DailyFocusPrototypePage />
          </Suspense>
        </Route>
        <Route>
          <Dashboard />
        </Route>
      </Switch>
    </ErrorBoundary>
  )
}
