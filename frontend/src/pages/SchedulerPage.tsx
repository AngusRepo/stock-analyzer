/**
 * SchedulerPage — Cron job monitoring dashboard
 *
 * 2026-04-21 rewrite: connects to /api/scheduler/status + /api/admin/costs/month.
 * Previously hardcoded mock data (Last sync 2026-04-11) for 3 months.
 */
import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Play, Pause, Clock, CheckCircle2, AlertTriangle,
  ArrowRight, Activity, RefreshCw, Loader2,
} from 'lucide-react'
import { schedulerApi, costsApi, type SchedulerStatus, type CostsMonth } from '@/lib/api'

// Build stamp — Vite replaces import.meta.env.VITE_BUILD_STAMP at build time.
// Injected via vite.config.ts `define`. If the visible banner still shows an
// older timestamp after deploy, the browser is still serving a cached bundle.
const BUILD_STAMP = (import.meta.env.VITE_BUILD_STAMP as string | undefined) || 'dev'

// ── Types ─────────────────────────────────────────────────────────────────
type JobStatus = 'success' | 'failed' | 'running' | 'paused' | 'skip'

// ── Small Components ─────────────────────────────────────────────────────
function StatusDot({ status }: { status: JobStatus }) {
  const cls = {
    success: 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.4)]',
    failed:  'bg-red-500 shadow-[0_0_6px_rgba(248,81,73,0.4)]',
    running: 'bg-sky-500 shadow-[0_0_6px_rgba(56,189,248,0.4)] animate-pulse',
    paused:  'bg-zinc-500',
    skip:    'bg-zinc-600',
  }
  return <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${cls[status]}`} />
}

function HistoryDots({ history }: { history: Array<'success'|'failed'|'skip'> }) {
  return (
    <div className="flex gap-0.5">
      {history.map((s, i) => (
        <div key={i} className={`w-2 h-2 rounded-sm ${
          s === 'success' ? 'bg-emerald-500' : s === 'failed' ? 'bg-red-500' : 'bg-zinc-700'
        }`} />
      ))}
    </div>
  )
}

function HeatmapCell({ value }: { value: string }) {
  if (value === 'skip') return <div className="h-7 rounded bg-zinc-800/50 flex items-center justify-center text-[10px] text-zinc-600">—</div>
  if (value === 'success') return <div className="h-7 rounded bg-emerald-500/15 flex items-center justify-center text-[10px] text-emerald-500 font-semibold">&#10003;</div>
  if (value === 'failed') return <div className="h-7 rounded bg-red-500/15 flex items-center justify-center text-[10px] text-red-500 font-semibold">&#10007;</div>
  return <div className="h-7 rounded bg-emerald-500/15 flex items-center justify-center text-[10px] text-emerald-500 font-semibold">{value}</div>
}

// ── Cost helpers ──────────────────────────────────────────────────────────
const COST_LABEL_MAP: Record<string, { label: string; color: string }> = {
  modal:     { label: 'Modal (compute + LLM image)', color: 'bg-amber-500' },
  anthropic: { label: 'Claude API',                  color: 'bg-sky-500' },
  gemini:    { label: 'Gemini API',                  color: 'bg-emerald-500' },
  deepseek:  { label: 'DeepSeek API',                color: 'bg-purple-500' },
  openai:    { label: 'OpenAI API',                  color: 'bg-zinc-400' },
  manual:    { label: 'Manual entries',              color: 'bg-zinc-600' },
}

function groupCosts(month: CostsMonth | null): Array<{ label: string; value: string; pct: number; color: string }> {
  if (!month) return []
  const total = Math.max(0.0001, month.total_usd)
  const bucket: Record<string, number> = {}
  for (const row of month.by_source) {
    const key = (row.provider || 'manual').toLowerCase()
    bucket[key] = (bucket[key] ?? 0) + (row.total_usd ?? 0)
  }
  return Object.entries(bucket)
    .sort(([, a], [, b]) => b - a)
    .map(([provider, sum]) => {
      const def = COST_LABEL_MAP[provider] || { label: provider, color: 'bg-zinc-500' }
      return {
        label: def.label,
        value: `$${sum.toFixed(2)}`,
        pct: Math.round((sum / total) * 100),
        color: def.color,
      }
    })
}

const MONTHLY_BUDGET = 100

// ── Main Page ────────────────────────────────────────────────────────────
export default function SchedulerPage() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [costs, setCosts] = useState<CostsMonth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  async function load() {
    try {
      setError(null)
      const [s, c] = await Promise.all([
        schedulerApi.status().catch(e => { throw new Error(`scheduler: ${e.message}`) }),
        costsApi.month().catch(() => null), // costs are optional — don't block main view
      ])
      setStatus(s)
      setCosts(c)
    } catch (e: any) {
      setError(e.message ?? 'Load failed')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
    // Auto-refresh every 60s while page is open
    const t = setInterval(() => { setRefreshing(true); load() }, 60_000)
    return () => clearInterval(t)
  }, [])

  if (loading) {
    return (
      <AppShell>
        <div className="p-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> 載入 Scheduler 狀態…
        </div>
      </AppShell>
    )
  }

  if (error || !status) {
    return (
      <AppShell>
        <div className="p-6 space-y-2">
          <div className="text-red-500 text-sm">Scheduler API 載入失敗：{error ?? 'no status'}</div>
          <Button size="sm" variant="outline" onClick={() => { setLoading(true); load() }}>重試</Button>
        </div>
      </AppShell>
    )
  }

  const jobs = status.jobs
  const stats = status.stats
  const lastSync = new Date().toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })

  // Group jobs for card display (non-table)
  const pipelineJobs = jobs.filter(j => j.group === 'pipeline_chain')
  const intradayJobs = jobs.filter(j => j.group === 'intraday')
  const weeklyJobs   = jobs.filter(j => j.group === 'weekly')
  const groups: Record<string, typeof jobs> = {
    'Daily Pipeline Chain': pipelineJobs,
    'Intraday': intradayJobs,
    'Weekly': weeklyJobs,
  }

  // DAG steps — derive from pipeline_chain in order
  const dagSteps = pipelineJobs.slice(0, 6).map(j => ({
    name: j.name,
    duration: j.lastDuration !== '—' ? j.lastDuration : '—',
    status: j.lastStatus,
  }))
  const dagLastRun = pipelineJobs.find(j => j.id === 'pipeline')?.lastRun ?? '—'
  const dagLastDuration = pipelineJobs.find(j => j.id === 'pipeline')?.lastDuration ?? '—'

  // Heatmap — one row per meaningful job (use top-12 by history7d non-skip count)
  const heatmapJobs = [...jobs]
    .filter(j => j.history7d.some(h => h !== 'skip'))
    .sort((a, b) => {
      const aCnt = a.history7d.filter(h => h !== 'skip').length
      const bCnt = b.history7d.filter(h => h !== 'skip').length
      return bCnt - aCnt
    })
    .slice(0, 10)

  const costBuckets = groupCosts(costs)
  const mtdTotal = costs?.total_usd ?? 0
  const budgetPct = Math.min(100, Math.round((mtdTotal / MONTHLY_BUDGET) * 1000) / 10)

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-bold">Scheduler Dashboard</h1>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.total} jobs &nbsp;|&nbsp; Last sync: {lastSync} TW
              {refreshing && <span className="ml-2 text-sky-400">refreshing…</span>}
              <span className="ml-2 text-zinc-600">· build {BUILD_STAMP}</span>
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setRefreshing(true); load() }}>
            <RefreshCw className="w-3 h-3 mr-1" /> 重整
          </Button>
        </div>

        {/* ═══ Two Column Layout ═══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

          {/* ═══ LEFT COLUMN ═══ */}
          <div className="space-y-6">

            {/* Stats */}
            <div className="grid grid-cols-4 gap-3">
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</p>
                <p className="text-2xl font-bold text-sky-400 mt-1">{stats.total}</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Success 7d</p>
                <p className="text-2xl font-bold text-emerald-500 mt-1">{stats.successRate7d}%</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Failed 24h</p>
                <p className={`text-2xl font-bold mt-1 ${stats.failed24h > 0 ? 'text-red-500' : 'text-emerald-500'}`}>{stats.failed24h}</p>
                {stats.failed24h > 0 && <p className="text-[10px] text-muted-foreground">needs attention</p>}
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Next Run</p>
                <p className="text-sm font-bold text-amber-500 mt-1 truncate">{stats.nextJob}</p>
                <p className="text-[10px] text-muted-foreground">{stats.nextIn}</p>
              </CardContent></Card>
            </div>

            {/* DAG */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Daily Pipeline DAG
                  <span className="ml-auto text-xs text-emerald-500">
                    Last: {dagLastRun} — {dagLastDuration}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {dagSteps.map((step, i) => (
                    <div key={step.name + i} className="flex items-center gap-1">
                      <div className={`rounded-lg border-2 px-3 py-2 text-center min-w-[80px] ${
                        step.status === 'success' ? 'border-emerald-500/60 bg-emerald-500/5' :
                        step.status === 'failed'  ? 'border-red-500/60 bg-red-500/5' :
                                                    'border-zinc-600'
                      }`}>
                        <p className="text-[11px] font-semibold">{step.name}</p>
                        <p className="text-[10px] text-muted-foreground">{step.duration}</p>
                      </div>
                      {i < dagSteps.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Job Cards */}
            <div className="space-y-4">
              {Object.entries(groups).map(([groupName, gjobs]) => (
                gjobs.length > 0 && (
                  <div key={groupName}>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 pl-1">{groupName}</p>
                    <div className="space-y-2">
                      {gjobs.map(job => (
                        <Card key={job.id} className={job.lastStatus === 'failed' ? 'border-red-500/30' : ''}>
                          <CardContent className="py-3 px-4 flex items-center gap-3">
                            <StatusDot status={job.lastStatus} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-semibold">{job.name}</span>
                                {job.chainIndex !== undefined && job.chainIndex > 0 && (
                                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0 bg-sky-500/10 text-sky-400 border-0">
                                    chain {job.chainIndex}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-muted-foreground">{job.schedule}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[11px] text-muted-foreground">
                                Last: {job.lastRun}{' '}
                                <span className={job.lastStatus === 'success' ? 'text-emerald-500' :
                                                 job.lastStatus === 'failed'  ? 'text-red-500' : 'text-zinc-500'}>
                                  {job.lastStatus === 'success' ? `✓ ${job.lastDuration}` :
                                   job.lastStatus === 'failed'  ? `✗ ${job.lastDuration}` : '—'}
                                </span>
                              </p>
                              <p className="text-[11px] text-sky-400">Next: {job.nextRun}</p>
                              <HistoryDots history={job.history7d} />
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button size="sm" variant="default" className="h-7 px-2 text-[11px] bg-emerald-600 hover:bg-emerald-700" disabled>
                                <Play className="w-3 h-3" />
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled>
                                <Pause className="w-3 h-3" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>

          {/* ═══ RIGHT COLUMN ═══ */}
          <div className="space-y-6">

            {/* Heatmap */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Weekly Success Heatmap
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="grid gap-1" style={{ gridTemplateColumns: '140px repeat(7, 1fr)' }}>
                  <div />
                  {['D-6','D-5','D-4','D-3','D-2','D-1','Today'].map(d => (
                    <div key={d} className="text-center text-[10px] text-muted-foreground pb-1">{d}</div>
                  ))}
                  {heatmapJobs.map(job => (
                    <div key={`row-${job.id}`} className="contents">
                      <div className="flex items-center text-[11px] pl-1 truncate">{job.name}</div>
                      {job.history7d.map((c, i) => <HeatmapCell key={`${job.id}-${i}`} value={c} />)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Job Details Table */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Clock className="w-4 h-4 text-sky-400" /> Job Details ({jobs.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-2 px-0">
                <div className="max-h-[400px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[10px] w-16">Status</TableHead>
                        <TableHead className="text-[10px]">Job</TableHead>
                        <TableHead className="text-[10px]">Schedule</TableHead>
                        <TableHead className="text-[10px]">Last Run</TableHead>
                        <TableHead className="text-[10px]">Duration</TableHead>
                        <TableHead className="text-[10px]">Next</TableHead>
                        <TableHead className="text-[10px]">7d</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map(job => (
                        <TableRow key={job.id}>
                          <TableCell className="py-1.5">
                            <Badge variant={job.lastStatus === 'success' ? 'default' :
                                             job.lastStatus === 'failed'  ? 'destructive' : 'secondary'}
                                   className={`text-[9px] px-1.5 ${
                                     job.lastStatus === 'success' ? 'bg-emerald-500/15 text-emerald-500 border-0' :
                                     job.lastStatus === 'skip'    ? 'bg-zinc-700/30 text-zinc-400 border-0' : ''
                                   }`}>
                              {job.lastStatus === 'success' ? '✓ OK' :
                               job.lastStatus === 'failed'  ? '✗ FAIL' : '— SKIP'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-[11px] font-medium py-1.5">{job.name}</TableCell>
                          <TableCell className="text-[11px] text-muted-foreground py-1.5">{job.schedule}</TableCell>
                          <TableCell className="text-[11px] py-1.5">{job.lastRun}</TableCell>
                          <TableCell className="text-[11px] py-1.5">{job.lastDuration}</TableCell>
                          <TableCell className="text-[11px] text-sky-400 py-1.5">{job.nextRun}</TableCell>
                          <TableCell className="text-[11px] py-1.5">{job.rate7d}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Cost Tracking */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" /> Cost Tracking (last 30d)
                  {!costs && <span className="text-[10px] text-muted-foreground ml-auto">載入中/N-A</span>}
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 space-y-3">
                {costBuckets.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3">
                    {costBuckets.map(c => (
                      <div key={c.label} className="space-y-1.5">
                        <p className="text-[10px] text-muted-foreground">{c.label}</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${c.color}`} style={{ width: `${c.pct}%` }} />
                          </div>
                          <span className="text-sm font-bold">{c.value}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">目前 30 天內尚未累積成本資料（cost_events 表空或 LLM 未觸發）</p>
                )}
                <div className="pt-2 border-t border-zinc-800">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[11px] text-muted-foreground">Monthly Budget</span>
                    <span className="text-base font-bold">
                      ${mtdTotal.toFixed(2)} <span className="text-sm font-normal text-muted-foreground">/ ${MONTHLY_BUDGET}</span>
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-amber-500" style={{ width: `${budgetPct}%` }} />
                  </div>
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>
    </AppShell>
  )
}
