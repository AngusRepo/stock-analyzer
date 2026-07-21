import rawPlan from './schedulerBatchPlan.json'

export interface SchedulerBatchSourceJob {
  id: string
  schedule: string
  task: string
  query?: string
  headers?: Record<string, string>
  timeZone?: string
  description?: string
}

export interface SchedulerBatchDefinition {
  id: string
  schedule: string
  jobs: SchedulerBatchSourceJob[]
}

interface SchedulerBatchPlan {
  schemaVersion: number
  timeZone: string
  batches: SchedulerBatchDefinition[]
}

export const SCHEDULER_BATCH_PLAN = rawPlan as SchedulerBatchPlan

const batchesById = new Map(SCHEDULER_BATCH_PLAN.batches.map((batch) => [batch.id, batch]))
const cronCache = new Map<string, CompiledCron>()

interface CompiledCron {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

function compileField(expression: string, min: number, max: number, normalize?: (value: number) => number): Set<number> {
  const values = new Set<number>()
  for (const token of expression.split(',')) {
    const [base, rawStep] = token.split('/')
    const step = rawStep === undefined ? 1 : Number.parseInt(rawStep, 10)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${token}`)

    let start: number
    let end: number
    if (base === '*') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const parts = base.split('-').map((part) => Number.parseInt(part, 10))
      if (parts.length !== 2 || parts.some((part) => !Number.isInteger(part))) {
        throw new Error(`Invalid cron range: ${token}`)
      }
      ;[start, end] = parts
    } else {
      start = Number.parseInt(base, 10)
      end = start
    }

    if (start < min || end > max || start > end) throw new Error(`Cron field out of range: ${token}`)
    for (let value = start; value <= end; value += step) values.add(normalize ? normalize(value) : value)
  }
  return values
}

function compileCron(schedule: string): CompiledCron {
  const cached = cronCache.get(schedule)
  if (cached) return cached
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Only five-field unix cron is supported: ${schedule}`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  const compiled: CompiledCron = {
    minute: compileField(minute, 0, 59),
    hour: compileField(hour, 0, 23),
    dayOfMonth: compileField(dayOfMonth, 1, 31),
    month: compileField(month, 1, 12),
    dayOfWeek: compileField(dayOfWeek, 0, 7, (value) => value === 7 ? 0 : value),
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  }
  cronCache.set(schedule, compiled)
  return compiled
}

export function cronMatchesUtc(schedule: string, scheduledAt: Date): boolean {
  if (Number.isNaN(scheduledAt.getTime())) return false
  const cron = compileCron(schedule)
  const dayOfMonthMatches = cron.dayOfMonth.has(scheduledAt.getUTCDate())
  const dayOfWeekMatches = cron.dayOfWeek.has(scheduledAt.getUTCDay())
  const dayMatches = cron.anyDayOfMonth
    ? dayOfWeekMatches
    : cron.anyDayOfWeek
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches
  return cron.minute.has(scheduledAt.getUTCMinutes()) &&
    cron.hour.has(scheduledAt.getUTCHours()) &&
    cron.month.has(scheduledAt.getUTCMonth() + 1) &&
    dayMatches
}

export function getSchedulerBatch(batchId: string): SchedulerBatchDefinition | undefined {
  return batchesById.get(batchId)
}

export function resolveDueSchedulerBatchJobs(batchId: string, scheduledAt: Date): SchedulerBatchSourceJob[] {
  const batch = getSchedulerBatch(batchId)
  if (!batch) throw new Error(`Unknown scheduler batch: ${batchId}`)
  if (!cronMatchesUtc(batch.schedule, scheduledAt)) return []
  return batch.jobs.filter((job) => {
    const timeZone = job.timeZone ?? SCHEDULER_BATCH_PLAN.timeZone
    if (timeZone !== 'UTC') throw new Error(`Batch source job ${job.id} must use UTC, got ${timeZone}`)
    return cronMatchesUtc(job.schedule, scheduledAt)
  })
}
