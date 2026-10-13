import type { SchedulerJob } from '@/lib/api'
import './JobRunTiming.css'

function available(value?: string | null): string | undefined {
  return value && !['N/A', '—', '-'].includes(value) ? value : undefined
}

export default function JobRunTiming({ job }: { job?: SchedulerJob }) {
  const timestamp = job?.lastRunAt || job?.lastEffectiveRunAt || job?.lastAttemptAt
  const date = timestamp ? new Date(timestamp) : null
  const lastRun = date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date)
    : available(job?.lastRun) ?? '尚無紀錄'
  const triggerOnly = job?.durationConcern === 'expected_short'
    && ['triggered', 'running'].includes(job.lastAttemptStatus ?? '')
  // A dispatch receipt measures the HTTP trigger, not the detached job's runtime.
  const duration = triggerOnly ? '待終態收據' : available(job?.lastDuration) ?? '未提供'

  return <span className="obs-job-timing">
    <span><span className="obs-job-timing__label">上次執行</span>
      <span className="sv-num" title={timestamp ? `${timestamp} · 顯示時間 Asia/Taipei` : undefined}>{lastRun}</span>
    </span>
    <span><span className="obs-job-timing__label">{triggerOnly ? '總耗時' : '耗時'}</span>
      <span className="sv-num" title={triggerOnly ? `目前只有啟動回報 ${job?.lastDuration ?? 'N/A'}，無完整執行耗時` : job?.durationConcernReason}>{duration}</span>
    </span>
  </span>
}
