import { Route, Switch } from 'wouter'
import { lazy, Suspense } from 'react'
import Dashboard from './pages/Dashboard'
import Unauthorized from './pages/Unauthorized'
import ErrorBoundary from './components/ErrorBoundary'

const BotDashboard = lazy(() => import('./pages/BotDashboard'))

export default function App() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/stock/:id" component={Dashboard} />
        <Route path="/unauthorized" component={Unauthorized} />
        <Route path="/bot">
          <Suspense fallback={<div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-500">Loading Bot Dashboard...</div>}>
            <BotDashboard />
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
