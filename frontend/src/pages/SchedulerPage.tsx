/**
 * SchedulerPage — Cron job monitoring dashboard
 *
 * Layout: Two-column (left: Stats + DAG + Job Cards, right: Heatmap + Table + Cost)
 * Data: Mock data for now, will connect to /api/admin/scheduler/status
 */
import AppShell from '@/components/AppShell'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Play, Pause, Clock, CheckCircle2, XCircle, AlertTriangle,
  ArrowRight, Activity,
} from 'lucide-react'

// ── Mock Data ────────────────────────────────────────────────────────────────

const STATS = { total: 20, active: 18, failed24h: 1, successRate7d: 96.4, nextJob: 'Pipeline', nextIn: '3d 2h' }

const DAG_STEPS = [
  { name: 'Bulk Fetch', duration: '3m12s', status: 'success' as const },
  { name: 'Screener', duration: '14s', status: 'success' as const },
  { name: 'ML Predict', duration: '4m18s', status: 'success' as const },
  { name: 'Recommend', duration: '2m05s', status: 'success' as const },
  { name: 'LLM Reason', duration: '1m42s', status: 'success' as const },
  { name: 'Write D1', duration: '8s', status: 'success' as const },
]

type JobStatus = 'success' | 'failed' | 'running' | 'paused'

interface Job {
  name: string
  schedule: string
  group: string
  chainIndex?: number
  lastRun: string
  lastStatus: JobStatus
  lastDuration: string
  nextRun: string
  history7d: JobStatus[]
}

const JOBS: Job[] = [
  { name: 'Pipeline', schedule: 'Weekdays 17:30', group: 'pipeline', chainIndex: 1, lastRun: '4/10 17:30', lastStatus: 'success', lastDuration: '11m42s', nextRun: '4/14 17:30', history7d: ['success','success','failed','success','success','success','success'] },
  { name: 'ML Predict', schedule: 'After pipeline', group: 'pipeline', chainIndex: 2, lastRun: '4/10 17:42', lastStatus: 'success', lastDuration: '4m18s', nextRun: 'After pipeline', history7d: ['success','success','failed','success','success','success','success'] },
  { name: 'Daily Rec', schedule: 'After ML predict', group: 'pipeline', chainIndex: 3, lastRun: '4/10 17:47', lastStatus: 'success', lastDuration: '2m05s', nextRun: 'After ML predict', history7d: ['success','success','success','success','success','success','success'] },
  { name: 'Intraday Re-score', schedule: '09-13h hourly', group: 'intraday', lastRun: '4/10 13:00', lastStatus: 'success', lastDuration: '45s', nextRun: '4/14 09:00', history7d: ['success','success','success','success','success','success','success'] },
  { name: 'EOD Exit', schedule: 'Weekdays 13:25', group: 'intraday', lastRun: '4/10 13:25', lastStatus: 'success', lastDuration: '12s', nextRun: '4/14 13:25', history7d: ['success','success','success','success','success','success','success'] },
  { name: 'Weekly Retrain', schedule: 'Saturday 06:00', group: 'weekly', lastRun: '4/5 06:00', lastStatus: 'failed', lastDuration: 'timeout', nextRun: '4/12 06:00', history7d: ['success','failed','failed','success','success','failed','success'] },
  { name: 'Weekly Cleanup', schedule: 'Sunday 04:00', group: 'weekly', lastRun: '4/6 04:00', lastStatus: 'success', lastDuration: '2m30s', nextRun: '4/13 04:00', history7d: ['success','success','success','success','success','success','success'] },
  { name: 'Weekly Audit', schedule: 'Friday 18:30', group: 'weekly', lastRun: '4/4 18:30', lastStatus: 'success', lastDuration: '3m12s', nextRun: '4/11 18:30', history7d: ['success','success','success','success','success','success','success'] },
]

const ALL_JOBS_TABLE = [
  { name: 'Pipeline', schedule: 'Weekdays 17:30', lastRun: '4/10 17:30', duration: '11m42s', nextRun: '4/14 17:30', rate7d: '4/5', status: 'success' as const },
  { name: 'ML Predict', schedule: 'After pipeline', lastRun: '4/10 17:42', duration: '4m18s', nextRun: 'After pipeline', rate7d: '4/5', status: 'success' as const },
  { name: 'Daily Recommendation', schedule: 'After ML predict', lastRun: '4/10 17:47', duration: '2m05s', nextRun: 'After ML', rate7d: '5/5', status: 'success' as const },
  { name: 'Morning Setup', schedule: 'Weekdays 07:15', lastRun: '4/10 07:15', duration: '32s', nextRun: '4/14 07:15', rate7d: '5/5', status: 'success' as const },
  { name: 'Morning Briefing', schedule: 'Weekdays 07:50', lastRun: '4/10 07:50', duration: '1m20s', nextRun: '4/14 07:50', rate7d: '5/5', status: 'success' as const },
  { name: 'ML Warmup', schedule: 'Weekdays 09:15', lastRun: '4/10 09:15', duration: '15s', nextRun: '4/14 09:15', rate7d: '5/5', status: 'success' as const },
  { name: 'Re-score 10:00', schedule: 'Weekdays 10:00', lastRun: '4/10 10:00', duration: '38s', nextRun: '4/14 10:00', rate7d: '5/5', status: 'success' as const },
  { name: 'Re-score 11:00', schedule: 'Weekdays 11:00', lastRun: '4/10 11:00', duration: '42s', nextRun: '4/14 11:00', rate7d: '5/5', status: 'success' as const },
  { name: 'Re-score 12:00', schedule: 'Weekdays 12:00', lastRun: '4/10 12:00', duration: '35s', nextRun: '4/14 12:00', rate7d: '5/5', status: 'success' as const },
  { name: 'Re-score 12:30', schedule: 'Weekdays 12:30', lastRun: '4/10 12:30', duration: '40s', nextRun: '4/14 12:30', rate7d: '5/5', status: 'success' as const },
  { name: 'Intraday Check', schedule: 'Weekdays 09-13h', lastRun: '4/10 13:00', duration: '45s', nextRun: '4/14 09:00', rate7d: '5/5', status: 'success' as const },
  { name: 'EOD Exit', schedule: 'Weekdays 13:25', lastRun: '4/10 13:25', duration: '12s', nextRun: '4/14 13:25', rate7d: '5/5', status: 'success' as const },
  { name: 'US Leading', schedule: 'Weekdays 06:30', lastRun: '4/10 06:30', duration: '8s', nextRun: '4/14 06:30', rate7d: '5/5', status: 'success' as const },
  { name: 'Daily Report', schedule: 'Weekdays 18:25', lastRun: '4/10 18:25', duration: '48s', nextRun: '4/14 18:25', rate7d: '5/5', status: 'success' as const },
  { name: 'Daily Snapshot', schedule: 'Weekdays 14:20', lastRun: '4/10 14:20', duration: '15s', nextRun: '4/14 14:20', rate7d: '5/5', status: 'success' as const },
  { name: 'Adapt Params', schedule: 'Weekdays 18:20', lastRun: '4/10 18:20', duration: '25s', nextRun: '4/14 18:20', rate7d: '5/5', status: 'success' as const },
  { name: 'Obsidian Sync', schedule: 'Weekdays 18:40', lastRun: '4/10 18:40', duration: '1m05s', nextRun: '4/14 18:40', rate7d: '5/5', status: 'success' as const },
  { name: 'Weekly Retrain', schedule: 'Saturday 06:00', lastRun: '4/5 06:00', duration: 'timeout', nextRun: '4/12 06:00', rate7d: '0/1', status: 'failed' as const },
  { name: 'Weekly Cleanup', schedule: 'Sunday 04:00', lastRun: '4/6 04:00', duration: '2m30s', nextRun: '4/13 04:00', rate7d: '1/1', status: 'success' as const },
  { name: 'Weekly Audit', schedule: 'Friday 18:30', lastRun: '4/4 18:30', duration: '3m12s', nextRun: '4/11 18:30', rate7d: '1/1', status: 'success' as const },
]

const HEATMAP_ROWS = [
  { name: 'Pipeline', cells: ['success','success','success','failed','success','skip','skip'] },
  { name: 'ML Predict', cells: ['success','success','success','failed','success','skip','skip'] },
  { name: 'Re-score (x3)', cells: ['3/3','3/3','3/3','3/3','3/3','skip','skip'] },
  { name: 'Morning Setup', cells: ['success','success','success','success','success','skip','skip'] },
  { name: 'US Leading', cells: ['success','success','success','success','success','skip','skip'] },
  { name: 'Retrain', cells: ['skip','skip','skip','skip','skip','failed','skip'] },
  { name: 'Cleanup', cells: ['skip','skip','skip','skip','skip','skip','success'] },
  { name: 'Obsidian Sync', cells: ['success','success','success','success','success','skip','skip'] },
]

const COSTS = [
  { label: 'Modal (GPU + CPU)', value: '$17.40', pct: 58, color: 'bg-amber-500' },
  { label: 'Cloud Run', value: '$3.20', pct: 12, color: 'bg-emerald-500' },
  { label: 'Claude API', value: '$2.10', pct: 8, color: 'bg-sky-500' },
  { label: 'Gemini API', value: '$0.85', pct: 3, color: 'bg-emerald-500' },
]

// ── Components ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: JobStatus }) {
  const cls = {
    success: 'bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.4)]',
    failed: 'bg-red-500 shadow-[0_0_6px_rgba(248,81,73,0.4)]',
    running: 'bg-sky-500 shadow-[0_0_6px_rgba(56,189,248,0.4)] animate-pulse',
    paused: 'bg-zinc-500',
  }
  return <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${cls[status]}`} />
}

function HistoryDots({ history }: { history: JobStatus[] }) {
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

// ── Main Page ────────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  const groups = {
    'Daily Pipeline Chain': JOBS.filter(j => j.group === 'pipeline'),
    'Intraday': JOBS.filter(j => j.group === 'intraday'),
    'Weekly': JOBS.filter(j => j.group === 'weekly'),
  }

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold">Scheduler Dashboard</h1>
          <p className="text-xs text-muted-foreground mt-1">20 Cloud Scheduler Jobs &nbsp;|&nbsp; Last sync: 2026-04-11 09:00 TW</p>
        </div>

        {/* ═══ Two Column Layout ═══ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

          {/* ═══ LEFT COLUMN ═══ */}
          <div className="space-y-6">

            {/* Stats */}
            <div className="grid grid-cols-4 gap-3">
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</p>
                <p className="text-2xl font-bold text-sky-400 mt-1">{STATS.total}</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Success 7d</p>
                <p className="text-2xl font-bold text-emerald-500 mt-1">{STATS.successRate7d}%</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Failed 24h</p>
                <p className="text-2xl font-bold text-red-500 mt-1">{STATS.failed24h}</p>
                <p className="text-[10px] text-muted-foreground">Retrain timeout</p>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3 px-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Next Run</p>
                <p className="text-sm font-bold text-amber-500 mt-1">{STATS.nextJob}</p>
                <p className="text-[10px] text-muted-foreground">{STATS.nextIn}</p>
              </CardContent></Card>
            </div>

            {/* DAG */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Daily Pipeline DAG
                  <span className="ml-auto text-xs text-emerald-500">Last: 4/10 — 11m42s &#10003;</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {DAG_STEPS.map((step, i) => (
                    <div key={step.name} className="flex items-center gap-1">
                      <div className={`rounded-lg border-2 px-3 py-2 text-center min-w-[80px] ${
                        step.status === 'success' ? 'border-emerald-500/60 bg-emerald-500/5' :
                        step.status === 'failed' ? 'border-red-500/60 bg-red-500/5' : 'border-zinc-600'
                      }`}>
                        <p className="text-[11px] font-semibold">{step.name}</p>
                        <p className="text-[10px] text-muted-foreground">{step.duration}</p>
                      </div>
                      {i < DAG_STEPS.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Job Cards */}
            <div className="space-y-4">
              {Object.entries(groups).map(([groupName, jobs]) => (
                <div key={groupName}>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2 pl-1">{groupName}</p>
                  <div className="space-y-2">
                    {jobs.map(job => (
                      <Card key={job.name} className={job.lastStatus === 'failed' ? 'border-red-500/30' : ''}>
                        <CardContent className="py-3 px-4 flex items-center gap-3">
                          <StatusDot status={job.lastStatus} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-semibold">{job.name}</span>
                              {job.chainIndex && (
                                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 bg-sky-500/10 text-sky-400 border-0">
                                  chain {job.chainIndex}/6
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground">{job.schedule}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[11px] text-muted-foreground">
                              Last: {job.lastRun} <span className={job.lastStatus === 'success' ? 'text-emerald-500' : 'text-red-500'}>
                                {job.lastStatus === 'success' ? `✓ ${job.lastDuration}` : `✗ ${job.lastDuration}`}
                              </span>
                            </p>
                            <p className="text-[11px] text-sky-400">Next: {job.nextRun}</p>
                            <HistoryDots history={job.history7d} />
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button size="sm" variant="default" className="h-7 px-2 text-[11px] bg-emerald-600 hover:bg-emerald-700">
                              <Play className="w-3 h-3" />
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]">
                              <Pause className="w-3 h-3" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
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
                <div className="grid gap-1" style={{ gridTemplateColumns: '120px repeat(7, 1fr)' }}>
                  <div />
                  {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                    <div key={d} className="text-center text-[10px] text-muted-foreground pb-1">{d}</div>
                  ))}
                  {HEATMAP_ROWS.map(row => (
                    <>
                      <div key={row.name} className="flex items-center text-[11px] pl-1">{row.name}</div>
                      {row.cells.map((c, i) => <HeatmapCell key={i} value={c} />)}
                    </>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Job Details Table */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Clock className="w-4 h-4 text-sky-400" /> Job Details
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
                      {ALL_JOBS_TABLE.map(job => (
                        <TableRow key={job.name}>
                          <TableCell className="py-1.5">
                            <Badge variant={job.status === 'success' ? 'default' : 'destructive'}
                                   className={`text-[9px] px-1.5 ${job.status === 'success' ? 'bg-emerald-500/15 text-emerald-500 border-0' : ''}`}>
                              {job.status === 'success' ? '✓ OK' : '✗ FAIL'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-[11px] font-medium py-1.5">{job.name}</TableCell>
                          <TableCell className="text-[11px] text-muted-foreground py-1.5">{job.schedule}</TableCell>
                          <TableCell className="text-[11px] py-1.5">{job.lastRun}</TableCell>
                          <TableCell className="text-[11px] py-1.5">{job.duration}</TableCell>
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
                  <AlertTriangle className="w-4 h-4 text-amber-500" /> Cost Tracking (MTD)
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  {COSTS.map(c => (
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
                {/* Budget */}
                <div className="pt-2 border-t border-zinc-800">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[11px] text-muted-foreground">Monthly Budget</span>
                    <span className="text-base font-bold">$23.55 <span className="text-sm font-normal text-muted-foreground">/ $100</span></span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-amber-500" style={{ width: '23.5%' }} />
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
