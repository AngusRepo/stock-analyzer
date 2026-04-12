import { Route, Switch } from 'wouter'
import { lazy, Suspense } from 'react'
import Dashboard from './pages/Dashboard'
import Unauthorized from './pages/Unauthorized'
import ErrorBoundary from './components/ErrorBoundary'

const BotDashboard = lazy(() => import('./pages/BotDashboard'))
const StockReportPage = lazy(() => import('./pages/StockReportPage'))
const PipelinePage = lazy(() => import('./pages/PipelinePage'))
const SchedulerPage = lazy(() => import('./pages/SchedulerPage'))

export default function App() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/stock/:id" component={Dashboard} />
        <Route path="/unauthorized" component={Unauthorized} />
        <Route path="/report/:symbol">
          <Suspense fallback={<div className="flex items-center justify-center h-screen bg-background text-muted-foreground">Loading Report...</div>}>
            <StockReportPage />
          </Suspense>
        </Route>
        <Route path="/bot">
          <Suspense fallback={<div className="flex items-center justify-center h-screen bg-background text-muted-foreground">Loading Bot Dashboard...</div>}>
            <BotDashboard />
          </Suspense>
        </Route>
        <Route path="/pipeline">
          <Suspense fallback={<div className="flex items-center justify-center h-screen bg-background text-muted-foreground">Loading Pipeline...</div>}>
            <PipelinePage />
          </Suspense>
        </Route>
        <Route path="/scheduler">
          <Suspense fallback={<div className="flex items-center justify-center h-screen bg-background text-muted-foreground">Loading Scheduler...</div>}>
            <SchedulerPage />
          </Suspense>
        </Route>
        <Route>
          <div className="flex items-center justify-center h-screen text-muted-foreground">
            <p>頁面不存在</p>
          </div>
        </Route>
      </Switch>
    </ErrorBoundary>
  )
}
