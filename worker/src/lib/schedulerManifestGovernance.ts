import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { getSchedulerDependencySpec } from './schedulerDependencyMap'

export type SchedulerAccountingClass = 'mapped_dependency' | 'standalone_root' | 'unmapped_dependency' | 'internal_chain'
export type SchedulerDesiredState = 'ENABLED' | 'PAUSED'

type ManifestJob = {
  id: string
  task: string
  desiredState?: SchedulerDesiredState
  retryConfig?: { retryCount?: number }
}

type GovernanceManifest = {
  governance: {
    schemaVersion: string
    defaults: { desiredState: SchedulerDesiredState }
  }
  jobs: ManifestJob[]
}

export type SchedulerJobAccounting = {
  schedulerJobId: string | null
  task: string
  physicalRoot: boolean
  desiredState: SchedulerDesiredState | null
  accountingClass: SchedulerAccountingClass
  dependencyReviewed: boolean
  ticketRequired: boolean
}

export type SchedulerGovernanceSummary = {
  schemaVersion: string
  physicalRoots: number
  pausedPhysicalRoots: number
  retryEnabledPhysicalRoots: number
  uniqueLogicalTasks: number
  accountedLogicalTasks: number
  reviewedDependencies: number
  standaloneRoots: number
  unmappedDependencies: number
  internalLogicalSteps: number
  unmappedTasks: string[]
}

const manifest = schedulerManifest as GovernanceManifest
const manifestJobs = manifest.jobs as ManifestJob[]
const manifestById = new Map(manifestJobs.map((job) => [job.id, job]))
const manifestByTask = new Map<string, ManifestJob[]>()
for (const job of manifestJobs) manifestByTask.set(job.task, [...(manifestByTask.get(job.task) ?? []), job])
const uniqueTasks = [...new Set(manifestJobs.map((job) => job.task))].sort()

function desiredState(job: ManifestJob): SchedulerDesiredState {
  return job.desiredState ?? manifest.governance.defaults.desiredState
}

function physicalAccountingClass(task: string): SchedulerAccountingClass {
  const dependency = getSchedulerDependencySpec(task)
  if (!dependency) return 'unmapped_dependency'
  return dependency.upstream.length > 0 || dependency.downstream.length > 0
    ? 'mapped_dependency'
    : 'standalone_root'
}

export function schedulerJobAccounting(jobId: string, chainIndex?: number): SchedulerJobAccounting {
  const exactPhysical = manifestById.get(jobId)
  const taskOwnedJobs = manifestByTask.get(jobId) ?? []
  const physical = exactPhysical ?? (taskOwnedJobs.length === 1 ? taskOwnedJobs[0] : undefined)
  if (physical) {
    const dependency = getSchedulerDependencySpec(physical.task)
    return {
      schedulerJobId: physical.id,
      task: physical.task,
      physicalRoot: true,
      desiredState: desiredState(physical),
      accountingClass: physicalAccountingClass(physical.task),
      dependencyReviewed: Boolean(dependency),
      ticketRequired: true,
    }
  }

  const dependency = getSchedulerDependencySpec(jobId)
  const internalChain = typeof chainIndex === 'number' || Boolean(dependency && dependency.owner !== 'gcp_scheduler')
  return {
    schedulerJobId: null,
    task: jobId,
    physicalRoot: false,
    desiredState: null,
    accountingClass: internalChain ? 'internal_chain' : 'unmapped_dependency',
    dependencyReviewed: Boolean(dependency),
    ticketRequired: internalChain,
  }
}

export function schedulerGovernanceSummary(internalLogicalSteps = 0): SchedulerGovernanceSummary {
  const classes = uniqueTasks.map((task) => physicalAccountingClass(task))
  const unmappedTasks = uniqueTasks.filter((task) => physicalAccountingClass(task) === 'unmapped_dependency')
  return {
    schemaVersion: manifest.governance.schemaVersion,
    physicalRoots: manifestJobs.length,
    pausedPhysicalRoots: manifestJobs.filter((job) => desiredState(job) === 'PAUSED').length,
    retryEnabledPhysicalRoots: manifestJobs.filter((job) => Number(job.retryConfig?.retryCount ?? 0) > 0).length,
    uniqueLogicalTasks: uniqueTasks.length,
    accountedLogicalTasks: classes.length,
    reviewedDependencies: uniqueTasks.filter((task) => Boolean(getSchedulerDependencySpec(task))).length,
    standaloneRoots: classes.filter((value) => value === 'standalone_root').length,
    unmappedDependencies: unmappedTasks.length,
    internalLogicalSteps,
    unmappedTasks,
  }
}

export function schedulerManifestJobs(): readonly ManifestJob[] {
  return manifestJobs
}
export type ManifestRepeatingWindow = {
  /** Manifest cron (UTC). */
  cron: string
  intervalMinutes: number
  /** Minutes of the Taiwan day of the first and last tick (the last may fall after midnight). */
  firstTwMinute: number
  lastTwMinute: number
  /** Last tick on the same Taiwan calendar day as the first one. */
  lastSameDayTwMinute: number
  label: string
}

const twHhMm = (minute: number) => {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** NEW-86: a weekday repeating window (`*\/N H1-H2 * * 1-5`, UTC) read from the scheduler manifest. */
export function manifestRepeatingWindow(
  jobId: string,
  source: { timeZone?: string; jobs: Array<{ id: string; schedule?: string; timeZone?: string }> } = schedulerManifest as any,
): ManifestRepeatingWindow {
  const job = source.jobs.find((row) => row.id === jobId)
  const match = /^\*\/(\d{1,2}) (\d{1,2})-(\d{1,2}) \* \* 1-5$/.exec(job?.schedule ?? '')
  // A per-job timeZone overrides the manifest default.
  if (!job || !match || (job.timeZone ?? source.timeZone) !== 'UTC') throw new Error(`manifest_repeating_window_invalid:${jobId}`)
  const [interval, startHour, endHour] = match.slice(1).map(Number)
  if (interval < 1 || interval > 59 || startHour > endHour || endHour > 23) throw new Error(`manifest_repeating_window_invalid:${jobId}`)
  const lastMinuteInHour = Math.floor(59 / interval) * interval
  const offset = startHour + 8 >= 24 ? 8 * 60 - 1440 : 8 * 60
  const firstTwMinute = startHour * 60 + offset
  const lastTwMinute = endHour * 60 + lastMinuteInHour + offset
  // Ticks run at minutes 0, N, 2N... of each hour, so the last same-day tick is in TW hour 23.
  const lastSameDayTwMinute = lastTwMinute < 1440 ? lastTwMinute : 23 * 60 + lastMinuteInHour
  return {
    cron: job.schedule!,
    intervalMinutes: interval,
    firstTwMinute,
    lastTwMinute,
    lastSameDayTwMinute,
    label: `Weekdays ${twHhMm(firstTwMinute)}-${twHhMm(lastTwMinute)} / ${interval}m`,
  }
}
