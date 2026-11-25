import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'

const JOB_ID = 'retention-archive-only'

// `M1,M2,... H1-H2 * * *` in UTC: the window's last tick is the last minute of the last hour.
export function retentionArchiveFinalTickUtc(
  source: { timeZone?: string; jobs: Array<{ id: string; schedule?: string; timeZone?: string }> } = schedulerManifest as any,
): { hour: number; minute: number } {
  const job = source.jobs.find((row) => row.id === JOB_ID)
  const match = /^(\d{1,2}(?:,\d{1,2})*) (\d{1,2})-(\d{1,2}) \* \* \*$/.exec(job?.schedule ?? '')
  if (!job || !match || (job.timeZone ?? source.timeZone) !== 'UTC') throw new Error(`retention_archive_window_invalid:${job?.schedule}`)
  return { hour: Number(match[3]), minute: Math.max(...match[1].split(',').map(Number)) }
}

export function isFinalRetentionArchiveTick(scheduledAt: string | null | undefined): boolean {
  const parsed = Date.parse(String(scheduledAt ?? ''))
  if (!Number.isFinite(parsed)) return false
  const at = new Date(parsed)
  const final = retentionArchiveFinalTickUtc()
  return at.getUTCHours() === final.hour && at.getUTCMinutes() === final.minute
}

/**
 * A lease-busy tick yields to the next one instead of failing. Only the window's final Scheduler
 * tick fails, and only when no tick of its business date archived anything: the job is the only
 * daily cold-archive writer, so a whole day without progress must surface as an error.
 */
export async function retentionArchiveDayStarved(db: D1Database, ticketId: string | undefined): Promise<boolean> {
  if (!ticketId) return false
  const ticket = await db.prepare(
    'SELECT scheduler_job_id, business_date, scheduled_at FROM scheduler_execution_tickets_v1 WHERE ticket_id=?',
  ).bind(ticketId).first<{ scheduler_job_id: string | null; business_date: string; scheduled_at: string | null }>()
  if (ticket?.scheduler_job_id !== JOB_ID || !isFinalRetentionArchiveTick(ticket.scheduled_at)) return false
  const success = await db.prepare(`
    SELECT 1 FROM scheduler_execution_tickets_v1
     WHERE scheduler_job_id=? AND business_date=? AND status='success' LIMIT 1
  `).bind(JOB_ID, ticket.business_date).first()
  return !success
}
