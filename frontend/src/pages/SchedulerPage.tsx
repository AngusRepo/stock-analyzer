/**
 * SchedulerPage - Cron job monitoring dashboard
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
  Play, Pause, Clock, CheckCircle2, AlertTriangle, ShieldCheck,
  ArrowRight, Activity, RefreshCw, Loader2,
} from 'lucide-react'
import { schedulerApi, costsApi, dataQualityApi, deployGateApi, type SchedulerStatus, type CostsMonth, type DataQualityReport, type DeployGateReport } from '@/lib/api'

const BUILD_STAMP = (import.meta.env.VITE_BUILD_STAMP as string | undefined) || 'dev'

type JobStatus = 'success' | 'failed' | 'running' | 'paused' | 'skip'

function StatusDot({ status }: { status: JobStatus }) {
  const cls = {
    success: 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.4)]',
    failed: 'bg-red-500 shadow-[0_0_6px_rgba(248,81,73,0.4)]',
    running: 'bg-sky-500 shadow-[0_0_6px_rgba(56,189,248,0.4)] animate-pulse',
    paused: 'bg-zinc-500',
    skip: 'bg-zinc-600',
  }
  return <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${cls[status]}`} />
}

function HistoryDots({ history }: { history: Array<'success' | 'failed' | 'skip'> }) {
  return (
    <div className="flex gap-0.5">
      {history.map((status, index) => (
        <div
          key={index}
          className={`w-2 h-2 rounded-sm ${
            status === 'success' ? 'bg-emerald-500' : status === 'failed' ? 'bg-red-500' : 'bg-zinc-700'
          }`}
        />
      ))}
    </div>
  )
}

function HeatmapCell({ value }: { value: string }) {
  if (value === 'skip') return <div className="h-7 rounded bg-zinc-800/50 flex items-center justify-center text-[10px] text-zinc-600">-</div>
  if (value === 'success') return <div className="h-7 rounded bg-emerald-500/15 flex items-center justify-center text-[10px] text-emerald-500 font-semibold">&#10003;</div>
  if (value === 'failed') return <div className="h-7 rounded bg-red-500/15 flex items-center justify-center text-[10px] text-red-500 font-semibold">&#10007;</div>
  return <div className="h-7 rounded bg-emerald-500/15 flex items-center justify-center text-[10px] text-emerald-500 font-semibold">{value}</div>
}

const COST_LABEL_MAP: Record<string, { label: string; color: string }> = {
  modal: { label: 'Modal (compute + LLM image)', color: 'bg-amber-500' },
  anthropic: { label: 'Claude API', color: 'bg-sky-500' },
  gemini: { label: 'Gemini API', color: 'bg-emerald-500' },
  deepseek: { label: 'DeepSeek API', color: 'bg-purple-500' },
  openai: { label: 'OpenAI API', color: 'bg-zinc-400' },
  manual: { label: 'Manual entries', color: 'bg-zinc-600' },
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

function qualityBadgeClass(status?: 'ok' | 'warn' | 'fail') {
  if (status === 'ok') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
  if (status === 'warn') return 'bg-amber-500/15 text-amber-300 border-amber-500/20'
  if (status === 'fail') return 'bg-red-500/15 text-red-300 border-red-500/20'
  return 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40'
}

export default function SchedulerPage() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [costs, setCosts] = useState<CostsMonth | null>(null)
  const [dataQuality, setDataQuality] = useState<DataQualityReport | null>(null)
  const [deployGate, setDeployGate] = useState<DeployGateReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  async function load() {
    try {
      setError(null)
      const [scheduler, monthCosts, quality, gate] = await Promise.all([
        schedulerApi.status().catch((e) => { throw new Error(`scheduler: ${e.message}`) }),
        costsApi.month().catch(() => null),
        dataQualityApi.status().catch(() => null),
        deployGateApi.predeploy().catch(() => null),
      ])
      setStatus(scheduler)
      setCosts(monthCosts)
      setDataQuality(quality)
      setDeployGate(gate)
    } catch (e: any) {
      setError(e.message ?? 'Load failed')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(() => {
      setRefreshing(true)
      load()
    }, 60_000)
    return () => clearInterval(timer)
  }, [])

  if (loading) {
    return (
      <AppShell>
        <div className="p-6 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> 載入 Scheduler 中...
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

  const pipelineJobs = jobs.filter((job) => job.group === 'pipeline_chain')
  const dailyJobs = jobs.filter((job) => job.group === 'daily')
  const intradayJobs = jobs.filter((job) => job.group === 'intraday')
  const weeklyJobs = jobs.filter((job) => job.group === 'weekly')
  const groups: Record<string, typeof jobs> = {
    'Daily Pipeline Chain': pipelineJobs,
    'Daily Ops': dailyJobs,
    Intraday: intradayJobs,
    Weekly: weeklyJobs,
  }

  const dagSteps = pipelineJobs.slice(0, 6).map((job) => ({
    name: job.name,
    duration: job.lastDuration !== 'N/A' ? job.lastDuration : 'N/A',
    status: job.lastStatus,
  }))
  const dagLastRun = pipelineJobs.find((job) => job.id === 'pipeline')?.lastRun ?? 'N/A'
  const dagLastDuration = pipelineJobs.find((job) => job.id === 'pipeline')?.lastDuration ?? 'N/A'

  const heatmapJobs = [...jobs]
    .filter((job) => job.history7d.some((item) => item !== 'skip'))
    .sort((a, b) => {
      const aCnt = a.history7d.filter((item) => item !== 'skip').length
      const bCnt = b.history7d.filter((item) => item !== 'skip').length
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
              {refreshing && <span className="ml-2 text-sky-400">refreshing...</span>}
              <span className="ml-2 text-zinc-600">| build {BUILD_STAMP}</span>
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setRefreshing(true); load() }}>
            <RefreshCw className="w-3 h-3 mr-1" /> 重新整理
          </Button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="space-y-6">
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Daily Pipeline DAG
                  <span className="ml-auto text-xs text-emerald-500">
                    Last: {dagLastRun} | {dagLastDuration}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {dagSteps.map((step, index) => (
                    <div key={step.name + index} className="flex items-center gap-1">
                      <div className={`rounded-lg border-2 px-3 py-2 text-center min-w-[80px] ${
                        step.status === 'success' ? 'border-emerald-500/60 bg-emerald-500/5' :
                        step.status === 'failed' ? 'border-red-500/60 bg-red-500/5' :
                          'border-zinc-600'
                      }`}
                      >
                        <p className="text-[11px] font-semibold">{step.name}</p>
                        <p className="text-[10px] text-muted-foreground">{step.duration}</p>
                      </div>
                      {index < dagSteps.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {Object.entries(groups).map(([groupName, groupJobs]) => (
                groupJobs.length > 0 && (
                  <div key={groupName}>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 pl-1">{groupName}</p>
                    <div className="space-y-2">
                      {groupJobs.map((job) => (
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
                              {job.summary && (
                                <p className="mt-1 text-[10px] text-muted-foreground/80 truncate" title={job.summary}>
                                  {job.summary}
                                </p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[11px] text-muted-foreground">
                                Last: {job.lastRun}{' '}
                                <span className={job.lastStatus === 'success' ? 'text-emerald-500' :
                                  job.lastStatus === 'failed' ? 'text-red-500' : 'text-zinc-500'}
                                >
                                  {job.lastStatus === 'success' ? `✓ ${job.lastDuration}` :
                                    job.lastStatus === 'failed' ? `✕ ${job.lastDuration}` : '-'}
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

          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Weekly Success Heatmap
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="grid gap-1" style={{ gridTemplateColumns: '140px repeat(7, 1fr)' }}>
                  <div />
                  {['D-6', 'D-5', 'D-4', 'D-3', 'D-2', 'D-1', 'Today'].map((label) => (
                    <div key={label} className="text-center text-[10px] text-muted-foreground pb-1">{label}</div>
                  ))}
                  {heatmapJobs.map((job) => (
                    <div key={`row-${job.id}`} className="contents">
                      <div className="flex items-center text-[11px] pl-1 truncate">{job.name}</div>
                      {job.history7d.map((cell, index) => <HeatmapCell key={`${job.id}-${index}`} value={cell} />)}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-sky-400" /> P9 Gate / P6 Data Quality
                  <Badge variant="outline" className={`ml-auto text-[10px] ${qualityBadgeClass(deployGate?.status)}`}>
                    {deployGate?.decision ?? 'N/A'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-[11px]">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
                    <div className="text-muted-foreground">Data quality</div>
                    <div className={`mt-1 font-semibold ${dataQuality?.overall === 'fail' ? 'text-red-300' : dataQuality?.overall === 'warn' ? 'text-amber-300' : 'text-emerald-300'}`}>
                      {dataQuality?.overall ?? 'unknown'}
                    </div>
                    <div className="mt-1 text-muted-foreground/70">date {dataQuality?.date ?? '-'}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
                    <div className="text-muted-foreground">Deploy gate</div>
                    <div className={`mt-1 font-semibold ${deployGate?.decision === 'BLOCK' ? 'text-red-300' : deployGate?.decision === 'WARN' ? 'text-amber-300' : 'text-emerald-300'}`}>
                      {deployGate?.decision ?? 'unknown'}
                    </div>
                    <div className="mt-1 text-muted-foreground/70">checks {deployGate?.checks?.length ?? 0}</div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {(dataQuality?.checks ?? []).slice(0, 6).map((check) => (
                    <div key={check.id} className="flex items-start gap-2 rounded-md border border-zinc-800/70 px-2 py-1.5 text-[11px]">
                      <Badge variant="outline" className={`h-5 px-1.5 text-[9px] ${qualityBadgeClass(check.status)}`}>
                        {check.status}
                      </Badge>
                      <div className="min-w-0">
                        <div className="font-medium">{check.label}</div>
                        <div className="truncate text-muted-foreground/70" title={check.summary}>{check.summary}</div>
                      </div>
                    </div>
                  ))}
                  {!dataQuality && <div className="text-[11px] text-muted-foreground">Data quality API 尚未載入或尚未部署。</div>}
                </div>
              </CardContent>
            </Card>

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
                      {jobs.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="py-1.5">
                            <Badge
                              variant={job.lastStatus === 'success' ? 'default' : job.lastStatus === 'failed' ? 'destructive' : 'secondary'}
                              className={`text-[9px] px-1.5 ${
                                job.lastStatus === 'success' ? 'bg-emerald-500/15 text-emerald-500 border-0' :
                                job.lastStatus === 'skip' ? 'bg-zinc-700/30 text-zinc-400 border-0' : ''
                              }`}
                            >
                              {job.lastStatus === 'success' ? 'OK' : job.lastStatus === 'failed' ? 'FAIL' : job.lastStatus === 'running' ? 'RUN' : 'SKIP'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-[11px] font-medium py-1.5">
                            <div>{job.name}</div>
                            {job.summary && (
                              <div className="max-w-[320px] truncate text-[10px] text-muted-foreground/70" title={job.summary}>
                                {job.summary}
                              </div>
                            )}
                          </TableCell>
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500" /> Cost Tracking (last 30d)
                  {!costs && <span className="text-[10px] text-muted-foreground ml-auto">資料暫無</span>}
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 space-y-3">
                {costBuckets.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3">
                    {costBuckets.map((bucket) => (
                      <div key={bucket.label} className="space-y-1.5">
                        <p className="text-[10px] text-muted-foreground">{bucket.label}</p>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${bucket.color}`} style={{ width: `${bucket.pct}%` }} />
                          </div>
                          <span className="text-sm font-bold">{bucket.value}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">最近 30 天尚無成本資料，請確認 `cost_events` 是否已有寫入。</p>
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
