import type { SchedulerJob } from '../../lib/api'

/** A watchdog that left no receipt in today's open window. Its row stays failed, but it is a recovery job,
 *  not a chain stage, so it never takes the "Blocked here" card from the stage the chain is actually on. */
export function isMissedWatchdog(job?: Pick<SchedulerJob, 'id' | 'lastError'>): boolean {
  return Boolean(job?.id.endsWith('-watchdog') && /^missed:/.test(job.lastError ?? ''))
}
