import type { SchedulerJob } from '../../lib/api'

const DISPATCH_AT = /waits for the after-close dispatch at (\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/

/** After serving, the root parks on the post-close research dispatch; returns its time ("11/2 14:20") while it waits. */
export function postcloseDispatchLabel(root?: SchedulerJob): string | null {
  if (root?.lastStatus !== 'waiting') return null
  const match = DISPATCH_AT.exec(root.summary ?? '')
  return match ? `${Number(match[2])}/${Number(match[3])} ${match[4]}` : null
}

/** A stage with no runtime log of its own says what it waits for instead of a generic upstream note. */
export function withPostcloseDispatchWait(job: SchedulerJob, label: string | null): SchedulerJob {
  if (!label || job.lastStatus !== 'waiting' || job.lastRunAt || job.summary) return job
  return { ...job, summary: `等待 ${label} 收盤後 research dispatch` }
}
