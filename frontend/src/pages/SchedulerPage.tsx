import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import { schedulerApi, type SchedulerJob } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  RefreshCw,
  TimerReset,
} from 'lucide-react'
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

function JobRow({ job }: { job: SchedulerJob }) {
  return (
    <div className="grid h-[64px] grid-cols-[1fr_92px_82px_92px] items-center gap-2 border-b border-[#263247] px-3 font-mono text-[11px]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-slate-100">{job.name}</p>
          {suspiciousDuration(job) && <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
        </div>
        <p className="truncate text-[#70809b]">{job.summary || job.schedule}</p>
      </div>
      <WorkstationPill tone={statusTone(job.lastStatus)}>{job.lastStatus || 'unknown'}</WorkstationPill>
      <span className={suspiciousDuration(job) ? 'text-amber-300' : 'text-[#8a92a6]'}>{job.lastDuration || '-'}</span>
      <span className="truncate text-right text-[#70809b]">{job.nextRun || '-'}</span>
    </div>
  )
}

function MetricCell({
  label,
  value,
  tone = 'neutral',
  detail,
}: {
  label: string
  value: string
  tone?: WorkstationTone
  detail?: string
}) {
  return (
    <div className="border-r border-[#263247] bg-[#070a10] p-3 last:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#8a92a6]">{label}</p>
      <p className={`mt-2 font-mono text-xl font-semibold ${tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'error' ? 'text-rose-300' : 'text-slate-100'}`}>
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  )
}

function PipelineDag({ jobs }: { jobs: SchedulerJob[] }) {
  const pipelineJobs = jobs.filter((job) => job.group === 'pipeline_chain').slice(0, 7)
  if (!pipelineJobs.length) {
    return <div className="p-4 text-sm text-slate-500">沒有 pipeline chain job payload。</div>
  }

  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      {pipelineJobs.map((job, index) => (
        <div key={job.id} className="flex items-center gap-2">
          <div className={`min-w-[116px] border px-3 py-2 ${
            job.lastStatus === 'success' ? 'border-emerald-400/35 bg-emerald-400/[0.06]' :
            job.lastStatus === 'failed' ? 'border-rose-400/35 bg-rose-400/[0.06]' :
              'border-[#263247] bg-[#05070c]'
          }`}
          >
            <p className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-slate-100">{job.name}</p>
            <p className="mt-1 text-[10px] text-[#8a92a6]">{job.lastDuration || '-'}</p>
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
          kicker="Scheduler Drilldown"
          title="Job Execution Explorer"
          description="只看排程 run state、callback contract、duration anomaly 與 dependency chain。不再複製 Data Quality、Deploy Gate 或成本面板。"
          action={
            <div className="flex flex-wrap gap-2">
              <a href="/obs" className="border border-sky-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-sky-300">back to OBS</a>
              <a href="/data-quality" className="border border-[#263247] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#8a92a6]">data-quality deep link</a>
              <button
                type="button"
                onClick={() => void scheduler.refetch()}
                className="inline-flex items-center gap-1 border border-amber-400/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200"
              >
                <RefreshCw className={`h-3 w-3 ${scheduler.isFetching ? 'animate-spin' : ''}`} />
                refresh
              </button>
            </div>
          }
        />

        {scheduler.error && (
          <div className="border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            Scheduler API 載入失敗：{(scheduler.error as Error).message}
          </div>
        )}

        <section className="grid grid-cols-1 gap-px border border-[#263247] bg-[#263247] md:grid-cols-5">
          <MetricCell label="total jobs" value={String(stats.total)} tone="info" detail={`${stats.active} active`} />
          <MetricCell label="success 7d" value={`${stats.successRate7d}%`} tone={stats.successRate7d >= 95 ? 'ok' : stats.successRate7d >= 80 ? 'warn' : 'error'} />
          <MetricCell label="failed 24h" value={String(stats.failed24h)} tone={stats.failed24h ? 'error' : 'ok'} detail={`${failedJobs.length} current failed`} />
          <MetricCell label="next job" value={stats.nextJob || 'N/A'} tone="neutral" detail={stats.nextIn || 'N/A'} />
          <MetricCell label="pipeline last" value={pipelineLast?.lastDuration ?? 'N/A'} tone={pipelineLast && !suspiciousDuration(pipelineLast) ? 'ok' : 'warn'} detail={pipelineLast?.lastRun ?? 'no run'} />
        </section>

        <WorkstationPanel title="Daily Pipeline DAG" kicker="dependency chain">
          <PipelineDag jobs={jobs} />
        </WorkstationPanel>

        <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <WorkstationPanel title="Job Run Table" kicker="run state, callback, duration">
            <VirtualizedList
              items={jobs}
              height={520}
              itemHeight={64}
              getKey={(job) => job.id}
              renderItem={(job) => <JobRow job={job} />}
              empty={<div className="p-4 text-sm text-slate-500">尚未取得 scheduler jobs。</div>}
            />
          </WorkstationPanel>

          <div className="space-y-4">
            <WorkstationPanel title="Run Anomaly Focus" kicker="failed or suspicious duration">
              <div className="space-y-2 p-3">
                {suspiciousJobs.slice(0, 8).map((job) => (
                  <div key={job.id} className="border border-[#263247] bg-[#05070c] p-3">
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
                  <div className="flex items-start gap-2 border border-emerald-400/20 bg-emerald-400/[0.05] p-3 text-sm text-emerald-300">
                    <CheckCircle2 className="mt-0.5 h-4 w-4" />
                    沒有 failed 或 suspicious duration job。
                  </div>
                )}
              </div>
            </WorkstationPanel>

            <WorkstationPanel title="Run Contract Notes" kicker="what this page owns">
              <div className="space-y-3 p-3 text-xs leading-5 text-[#8a92a6]">
                <div className="flex gap-2">
                  <Clock className="mt-0.5 h-4 w-4 text-sky-300" />
                  <span>下一次執行時間必須吃交易日曆與 holiday gate，不用 Data Quality 狀態推論。</span>
                </div>
                <div className="flex gap-2">
                  <TimerReset className="mt-0.5 h-4 w-4 text-amber-300" />
                  <span>`&lt;1s`、`--`、`N/A` 是 run/callback 可觀測性問題，先查 run_id 與 final callback。</span>
                </div>
                <div className="flex gap-2">
                  <Activity className="mt-0.5 h-4 w-4 text-emerald-300" />
                  <span>資料 freshness、schema、parity 已移到 OBS/Data Quality；本頁不重複抓它們。</span>
                </div>
              </div>
            </WorkstationPanel>
          </div>
        </section>
      </div>
    </AppShell>
  )
}
