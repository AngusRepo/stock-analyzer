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
export type EodExitSchedule = {
  /** Manifest cron (UTC), the single owner of the EOD exit time. */
  cron: string
  /** Minute of the Taiwan day when the scheduled run fires. */
  twMinute: number
  /** HH:MM Taiwan time. */
  twTime: string
  /** Manual/scheduled trigger window [twMinute, windowEndTwMinute). */
  windowEndTwMinute: number
}

export const EOD_EXIT_TRIGGER_WINDOW_MINUTES = 10

const twClock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** AUD-4: the EOD exit time is owned by the scheduler manifest; every Worker reader derives from it. */
export function eodExitSchedule(manifest: { timeZone?: string; jobs: Array<{ id: string; schedule?: string; timeZone?: string }> } = schedulerManifest as any): EodExitSchedule {
  const job = manifest.jobs.find(row => row.id === 'eod-exit')
  const match = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/.exec(job?.schedule ?? '')
  // A per-job timeZone overrides the manifest default.
  if (!job || !match || (job.timeZone ?? manifest.timeZone) !== 'UTC') throw new Error('eod_exit_schedule_invalid')
  const utcMinute = Number(match[2]) * 60 + Number(match[1])
  if (Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error('eod_exit_schedule_invalid')
  const twMinute = (utcMinute + 8 * 60) % (24 * 60)
  return { cron: job.schedule!, twMinute, twTime: twClock(twMinute), windowEndTwMinute: twMinute + EOD_EXIT_TRIGGER_WINDOW_MINUTES }
}

export function eodExitWindowLabel(schedule: EodExitSchedule = eodExitSchedule()): string {
  return `${schedule.twTime}-${twClock(schedule.windowEndTwMinute - 1)}`
}
