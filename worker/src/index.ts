import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Bindings, Variables, UpdateQueueMsg } from './types'
import {
  runDailyUpdate as runDailyUpdateWorkflow,
  processUpdateBatch,
} from './lib/updateOrchestrator'
import { runMorningWarmup } from './lib/localMaintenance'
import {
  runDailyRecommendation,
  runMarketScreener,
} from './lib/pipelineOrchestrator'
import { runMLAndRiskV2 } from './lib/mlPipelineTrigger'
import { runDailySnapshot, runPaperAutoTrade } from './lib/paperWorkerTasks'
import { runEODExit } from './lib/paperExitTasks'
import { handleScheduledCron } from './lib/cronOrchestrator'
import {
  runWeeklyAudit as runWeeklyAuditWorkflow,
  runWeeklyOptunaResearch as runWeeklyOptunaResearchWorkflow,
  runWeeklyLifecycleCheck as runWeeklyLifecycleCheckWorkflow,
  runWeeklyBacktest as runWeeklyBacktestWorkflow,
  runWeeklyMonteCarlo as runWeeklyMonteCarloWorkflow,
  runWeeklyPBO as runWeeklyPboWorkflow,
  runWeeklyAlphaQuality as runWeeklyAlphaQualityWorkflow,
  runMonthlyOptunaResearch as runMonthlyOptunaResearchWorkflow,
  runOptunaQueueProcessor as runOptunaQueueProcessorWorkflow,
} from './lib/controllerWorkflows'
import { auth } from './routes/auth'
import { adminReadRoutes } from './routes/adminReadRoutes'
import { dashboardReadRoutes } from './routes/dashboardReadRoutes'
import { scheduleReadRoutes } from './routes/scheduleReadRoutes'
import { adminSimulationRoutes } from './routes/adminSimulationRoutes'
import { adminControlRoutes } from './routes/adminControlRoutes'
import { adminParityRoutes } from './routes/adminParityRoutes'
import { adminWriteRoutes } from './routes/adminWriteRoutes'
import { adminConfigCoreRoutes } from './routes/adminConfigCoreRoutes'
import { adminConfigWorkflowRoutes } from './routes/adminConfigWorkflowRoutes'
import { adminConfigLifecycleRoutes } from './routes/adminConfigLifecycleRoutes'
import { adminOptunaRoutes } from './routes/adminOptunaRoutes'
import { buildAdminTriggerTaskMap } from './lib/adminTriggerTaskMap'
import { createAdminTriggerRoutes } from './routes/adminTriggerRoutes'
import { buildWorkerHealthPayload } from './lib/runtimeVersion'
import { stocks } from './routes/stocks'
import { market, llm, watchlist, alerts, news, ml, notifications, system, recommendations, chat } from './routes/other'
import { paper } from './routes/paper'
import { runIntradayCheck } from './lib/paperEntryTasks'
import { setupMorningPendingBuys } from './lib/pendingBuyOrchestrator'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const adminTriggerRoutes = createAdminTriggerRoutes({
  buildTaskMap: (c: any) => buildAdminTriggerTaskMap(c, {
    runMarketScreener: (runDate?: string) => runMarketScreener(c.env, runDate),
    runDailyUpdate: (force?: boolean, runDate?: string) => runDailyUpdateWorkflow(c.env, force, runDate),
    runMLAndRiskV2: (runDate?: string) => runMLAndRiskV2(c.env, runDate),
    runDailyRecommendation: (runDate?: string) => runDailyRecommendation(c.env, runDate),
    runPaperAutoTrade: () => runPaperAutoTrade(c.env),
    setupMorningPendingBuys: () => setupMorningPendingBuys(c.env),
    runIntradayCheck: () => runIntradayCheck(c.env),
    runEODExit: () => runEODExit(c.env),
    runDailySnapshot: () => runDailySnapshot(c.env),
    runMorningWarmup: () => runMorningWarmup(c.env),
    runWeeklyAudit: () => runWeeklyAuditWorkflow(c.env),
    runWeeklyBacktest: () => runWeeklyBacktestWorkflow(c.env),
    runWeeklyMonteCarlo: () => runWeeklyMonteCarloWorkflow(c.env),
    runWeeklyPBO: () => runWeeklyPboWorkflow(c.env),
    runWeeklyAlphaQuality: () => runWeeklyAlphaQualityWorkflow(c.env),
    runWeeklyLifecycleCheck: () => runWeeklyLifecycleCheckWorkflow(c.env),
    runWeeklyOptunaResearch: () => runWeeklyOptunaResearchWorkflow(c.env),
    runMonthlyOptunaResearch: () => runMonthlyOptunaResearchWorkflow(c.env),
    runOptunaQueueProcessor: () => runOptunaQueueProcessorWorkflow(c.env),
  }),
})

// P3 資安：Security headers（防 XSS + clickjacking + MIME sniffing）
app.use('/api/*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
})

app.use('/api/*', cors({
  origin: (origin, c) => {
    // server-to-server（Cron、Queue）：無 Origin header，直接放行
    if (origin === undefined || origin === '') return ''
    // 'null' origin = sandboxed iframe 攻擊，明確拒絕
    if (origin === 'null') return null
    // 精確比對：避免 evil-stockvision.pages.dev 繞過；PAGES_ORIGIN 空白時不加入白名單
    const pagesOrigin = (c.env.PAGES_ORIGIN ?? '').trim()
    const allowed = new Set([
      ...(pagesOrigin ? [pagesOrigin] : []),
      'http://localhost:5173',
      'http://localhost:4173',
      'http://localhost:3000',
    ])
    return allowed.has(origin) ? origin : null
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}))

// ─── Security Headers ──────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  await next()
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // CSP：API 回應不渲染 HTML，但前端靜態頁面由 Pages 負責
  if (c.req.path.startsWith('/api/')) {
    c.res.headers.set('Content-Security-Policy', "default-src 'none'")
  }
})

app.route('/api/auth',      auth)
app.route('/api/stocks',    stocks)
app.route('/api/market',    market)
app.route('/api/llm',       llm)
app.route('/api/watchlist', watchlist)
app.route('/api/alerts',    alerts)
app.route('/api/news',      news)
app.route('/api/ml',        ml)
app.route('/api/notifications', notifications)
app.route('/api/system',        system)
app.route('/api/recommendations', recommendations)
app.route('/api/chat',            chat)
app.route('/api/paper',           paper)
app.route('/',                    adminReadRoutes)
app.route('/',                    dashboardReadRoutes)
app.route('/',                    scheduleReadRoutes)
app.route('/',                    adminSimulationRoutes)
app.route('/',                    adminControlRoutes)
app.route('/',                    adminParityRoutes)
app.route('/',                    adminWriteRoutes)
app.route('/',                    adminConfigCoreRoutes)
app.route('/',                    adminConfigWorkflowRoutes)
app.route('/',                    adminConfigLifecycleRoutes)
app.route('/',                    adminOptunaRoutes)
app.route('/',                    adminTriggerRoutes)
app.get('/api/health', (c) => c.json(buildWorkerHealthPayload()))
export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    await handleScheduledCron(event, env, ctx)
  },

  async queue(
    batch: MessageBatch<UpdateQueueMsg>,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    void ctx
    await Promise.all(batch.messages.map(async (msg) => {
      try {
        await processUpdateBatch(msg.body, env, {
          runMarketScreener,
          runMLAndRiskV2,
        })
        msg.ack()
      } catch (e) {
        console.error(`[Queue] Message failed, will retry:`, e)
        msg.retry()
      }
    }))
  },
}
