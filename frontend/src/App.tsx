import { Redirect, Route, Switch } from 'wouter'
import { lazy, Suspense } from 'react'
import Dashboard from './pages/Dashboard'
import Unauthorized from './pages/Unauthorized'
import ErrorBoundary from './components/ErrorBoundary'

const BotDashboard = lazy(() => import('./pages/BotDashboard'))
const DailyFocusHomePage = lazy(() => import('./pages/DailyFocusHomePage'))
const LegacyStockReportRedirectPage = lazy(() => import('./pages/LegacyStockReportRedirectPage'))
const PipelinePage = lazy(() => import('./pages/PipelinePage'))
const SchedulerPage = lazy(() => import('./pages/SchedulerPage'))
const ModelPoolPage = lazy(() => import('./pages/ModelPoolPage'))
const ModelPoolInspectorPage = lazy(() => import('./pages/ModelPoolInspectorPage'))
const DataQualityPage = lazy(() => import('./pages/DataQualityPage'))
const StrategyLabPage = lazy(() => import('./pages/StrategyLabPage'))
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage'))
const UiuxRoadmapDemoPage = lazy(() => import('./pages/UiuxRoadmapDemoPage'))

function PageLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background text-muted-foreground">
      Loading {label}...
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={DailyFocusHomePage} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/stock/:id" component={Dashboard} />
        <Route path="/unauthorized" component={Unauthorized} />
        <Route path="/report/:symbol">
          <Suspense fallback={<PageLoader label="Legacy stock report" />}>
            <LegacyStockReportRedirectPage />
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
        <Route path="/model-pool/inspector">
          <Suspense fallback={<PageLoader label="Model Pool Inspector" />}>
            <ModelPoolInspectorPage />
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
          <Redirect to="/" replace />
        </Route>
        <Route path="/preview/uiux-roadmap">
          <Suspense fallback={<PageLoader label="UIUX Roadmap Demo" />}>
            <UiuxRoadmapDemoPage />
          </Suspense>
        </Route>
        <Route>
          <Dashboard />
        </Route>
      </Switch>
    </ErrorBoundary>
  )
}
