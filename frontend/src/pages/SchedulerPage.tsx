import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, ArrowRight, Clock, ExternalLink, RefreshCw } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { schedulerApi, type SchedulerJob } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import { VirtualizedList } from '@/components/performance/VirtualizedList'

function statusTone(status?: string): WorkstationTone {
  if (status === 'success') return 'ok'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'warn'
  if (status === 'skip' || status === 'skipped') return 'neutral'
  return 'neutral'
}

function suspiciousDuration(job: SchedulerJob) {
  return job.lastDuration === '<1s' || job.lastDuration === '--' || job.lastDuration === 'N/A'
}

function HistoryStrip({ history }: { history: Array<'success' | 'failed' | 'skip'> }) {
  const items = history.length ? history : ['skip', 'skip', 'skip', 'skip', 'skip', 'skip', 'skip']
  return (
    <div className="flex gap-1" aria-label="7 day scheduler status">
      {items.map((status, index) => (
        <span
          key={`${status}-${index}`}
          className={`h-2 flex-1 rounded-full ${
            status === 'success' ? 'bg-emerald-400' : status === 'failed' ? 'bg-rose-400' : 'bg-slate-700'
          }`}
        />
      ))}
    </div>
  )
}

function MetricCell({ label, value, tone = 'neutral', detail }: {
  label: string
  value: string
  tone?: WorkstationTone
  detail?: string
}) {
  return (
    <div className="border-r border-[#263247] bg-[#070a10] p-3 last:border-r-0">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a92a6]">{label}</p>
        <WorkstationPill tone={tone}>{tone}</WorkstationPill>
      </div>
      <p className={`mt-2 font-mono text-xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-100'}`}>
        {value}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'error' ? 'bg-rose-400' : 'bg-slate-500'}`} style={{ width: tone === 'error' ? '100%' : tone === 'warn' ? '64%' : '92%' }} />
      </div>
      {detail && <p className="mt-1 truncate text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function JobRow({ job }: { job: SchedulerJob }) {
  const suspicious = suspiciousDuration(job)
  return (
    <div className="grid h-[76px] grid-cols-[1fr_96px_92px_112px] items-center gap-2 border-b border-[#263247] px-3 font-mono text-[11px]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus || 'unknown'}</WorkstationPill>
          <p className="truncate text-slate-100">{job.name}</p>
          {suspicious && <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
        </div>
        <p className="mt-1 truncate text-[#70809b]">{job.group} / {job.summary || job.schedule}</p>
        <div className="mt-2 max-w-[220px]">
          <HistoryStrip history={job.history7d ?? []} />
        </div>
      </div>
      <span className={suspicious ? 'text-amber-300' : 'text-[#8a92a6]'}>{job.lastDuration || '-'}</span>
      <span className="truncate text-[#8a92a6]">{job.rate7d || '-'}</span>
      <span className="truncate text-right text-[#70809b]">{job.nextRun || '-'}</span>
    </div>
  )
}

function PipelineDag({ jobs }: { jobs: SchedulerJob[] }) {
  const pipelineJobs = jobs.filter((job) => job.group === 'pipeline_chain').slice(0, 8)
  if (!pipelineJobs.length) {
    return <div className="p-4 text-sm text-slate-500">目前沒有 pipeline chain job payload。</div>
  }

  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      {pipelineJobs.map((job, index) => (
        <div key={job.id} className="flex items-center gap-2">
          <div className={`min-w-[116px] rounded-xl border px-3 py-2 ${
            job.lastStatus === 'success' ? 'border-emerald-400/35 bg-emerald-400/[0.06]' :
            job.lastStatus === 'failed' ? 'border-rose-400/35 bg-rose-400/[0.06]' :
              'border-[#263247] bg-[#05070c]'
          }`}
          >
            <p className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{job.name}</p>
            <p className="mt-1 text-[10px] text-[#8a92a6]">{job.lastDuration || '-'}</p>
            <HistoryStrip history={job.history7d ?? []} />
          </div>
          {index < pipelineJobs.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-amber-300" />}
        </div>
      ))}
    </div>
  )
}

export default function SchedulerPage() {
  const scheduler = useQuery({
    queryKey: ['scheduler', 'drilldown'],
    queryFn: schedulerApi.status,
    refetchInterval: 60_000,
    staleTime: queryTtl.realtime,
  })

  const jobs = scheduler.data?.jobs ?? []
  const failedJobs = jobs.filter((job) => job.lastStatus === 'failed')
  const suspiciousJobs = jobs.filter((job) => job.lastStatus === 'failed' || suspiciousDuration(job))
  const stats = scheduler.data?.stats ?? {
    total: 0,
    active: 0,
    failed24h: 0,
    successRate7d: 0,
    nextJob: 'N/A',
    nextIn: 'N/A',
  }
  const pipelineLast = jobs.find((job) => job.id === 'pipeline')

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="Scheduler"
          title="Scheduler Drilldown / 排程追蹤"
          description="用 SLO、7 日狀態條、duration 與 next run 判斷：排程有沒有跑、是不是假成功、下一個卡點在哪。"
          action={
            <div className="flex flex-wrap gap-2">
              <a href="/obs" className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]">
                OBS <ExternalLink className="h-3 w-3" />
              </a>
              <a href="/data-quality" className="inline-flex items-center gap-1 rounded-full border border-[#3a3125] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#b9b1a1]">
                Data Quality <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                onClick={() => void scheduler.refetch()}
                className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]"
              >
                <RefreshCw className={`h-3 w-3 ${scheduler.isFetching ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          }
        />

        {scheduler.error && (
          <div className="border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            Scheduler API 載入失敗：{(scheduler.error as Error).message}
          </div>
        )}

        <section className="grid grid-cols-1 overflow-hidden rounded-2xl border border-[#3a3125] bg-[#3a3125] md:grid-cols-5">
          <MetricCell label="Jobs" value={String(stats.total)} tone="info" detail={`${stats.active} active`} />
          <MetricCell label="7d SLO" value={`${stats.successRate7d}%`} tone={stats.successRate7d >= 95 ? 'ok' : stats.successRate7d >= 80 ? 'warn' : 'error'} />
          <MetricCell label="24h Failed" value={String(stats.failed24h)} tone={stats.failed24h ? 'error' : 'ok'} detail={`${failedJobs.length} current failed`} />
          <MetricCell label="Next Job" value={stats.nextJob || 'N/A'} tone="neutral" detail={stats.nextIn || 'N/A'} />
          <MetricCell label="Pipeline" value={pipelineLast?.lastDuration ?? 'N/A'} tone={pipelineLast && !suspiciousDuration(pipelineLast) ? 'ok' : 'warn'} detail={pipelineLast?.lastRun ?? 'no run'} />
        </section>

        <WorkstationPanel title="Daily Pipeline Chain / 每日流程鏈" kicker="dependency chain">
          <PipelineDag jobs={jobs} />
        </WorkstationPanel>

        <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <WorkstationPanel title="Scheduler Runs / 排程執行" kicker="run state, callback, duration">
            <VirtualizedList
              items={jobs}
              height={520}
              itemHeight={76}
              getKey={(job) => job.id}
              renderItem={(job) => <JobRow job={job} />}
              empty={<div className="p-4 text-sm text-slate-500">尚未取得 scheduler jobs。</div>}
            />
          </WorkstationPanel>

          <WorkstationPanel title="Needs Attention / 優先處理" kicker="failed or suspicious duration">
            <div className="space-y-2 p-3">
              {suspiciousJobs.slice(0, 8).map((job) => (
                <div key={job.id} className="rounded-xl border border-[#263247] bg-[#05070c] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{job.name}</p>
                      <p className="mt-1 text-xs leading-5 text-[#8a92a6]">{job.summary || job.schedule}</p>
                    </div>
                    <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus}</WorkstationPill>
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-[#70809b]">last {job.lastRun} / duration {job.lastDuration} / next {job.nextRun}</p>
                </div>
              ))}
              {!suspiciousJobs.length && (
                <div className="flex items-start gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3 text-sm text-emerald-300">
                  <Activity className="mt-0.5 h-4 w-4" />
                  目前沒有 failed 或 suspicious duration job。
                </div>
              )}
              <div className="rounded-xl border border-[#263247] bg-[#05070c] p-3 text-xs leading-5 text-slate-400">
                <div className="mb-2 flex items-center gap-2 text-sky-300">
                  <Clock className="h-4 w-4" />
                  Reading rule
                </div>
                <span className="font-mono">&lt;1s</span>、<span className="font-mono">--</span>、<span className="font-mono">N/A</span> 代表需要追 callback / queue / run log，不應直接視為成功。
              </div>
            </div>
          </WorkstationPanel>
        </section>
      </div>
    </AppShell>
  )
}
