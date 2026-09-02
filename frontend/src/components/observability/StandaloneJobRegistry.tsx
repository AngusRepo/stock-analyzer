import { AlertTriangle, ArrowRight, CalendarClock, CircleDot, ListTree } from 'lucide-react'
import type { SchedulerJob, SchedulerStatus } from '@/lib/api'
import './StandaloneJobRegistry.css'

const GROUP_LABEL: Record<SchedulerJob['group'], string> = {
  pipeline_chain: 'Pipeline support',
  intraday: 'Intraday roots',
  daily: 'Daily operations',
  weekly: 'Weekly operations',
  monthly: 'Monthly operations',
}

const GROUP_ORDER: SchedulerJob['group'][] = ['weekly', 'pipeline_chain', 'daily', 'intraday', 'monthly']

const STATUS_LABEL: Record<SchedulerJob['lastStatus'], string> = {
  success: 'Completed',
  failed: 'Failed',
  running: 'Running',
  waiting: 'Waiting',
  sleep: 'Not in window',
  skip: 'No action',
}

const STATUS_ORDER: Record<SchedulerJob['lastStatus'], number> = {
  failed: 0,
  running: 1,
  waiting: 2,
  success: 3,
  sleep: 4,
  skip: 5,
}

function dependencyEvidence(job: SchedulerJob) {
  const upstream = job.consolidation?.upstream?.filter(Boolean) ?? []
  const downstream = job.consolidation?.downstream?.filter(Boolean) ?? []
  const hasDependency = upstream.length > 0 || downstream.length > 0 || typeof job.chainIndex === 'number'
  const accountingClass = job.accounting?.accountingClass ?? 'unmapped_dependency'
  if (accountingClass === 'unmapped_dependency') {
    return { upstream, downstream, hasDependency, isTopologyGap: true, label: 'Unmapped dependency' }
  }
  if (accountingClass === 'standalone_root') {
    return { upstream, downstream, hasDependency: false, isTopologyGap: false, label: 'Standalone root' }
  }
  if (accountingClass === 'internal_chain') {
    return { upstream, downstream, hasDependency: true, isTopologyGap: false, label: 'Internal logical ticket' }
  }
  return { upstream, downstream, hasDependency: true, isTopologyGap: false, label: 'Dependency reviewed' }
}

function statusCount(jobs: SchedulerJob[], status: SchedulerJob['lastStatus']) {
  return jobs.filter((job) => job.lastStatus === status).length
}

function ticketLabel(ticket: SchedulerJob['ticket'] | undefined) {
  if (ticket?.ticketId) return ticket.ticketId.slice(0, 18)
  return ticket?.missing ? 'missing' : 'not required'
}

export default function StandaloneJobRegistry({
  jobs,
  mappedJobIds,
  governance,
}: {
  jobs: SchedulerJob[]
  mappedJobIds: ReadonlySet<string>
  governance?: SchedulerStatus['governance']
}) {
  const registryJobs = jobs
    .filter((job) => !mappedJobIds.has(job.id))
    .sort((a, b) => STATUS_ORDER[a.lastStatus] - STATUS_ORDER[b.lastStatus] || a.name.localeCompare(b.name))
  const mappedCount = jobs.length - registryJobs.length

  return (
    <section className="obs-standalone" aria-labelledby="obs-standalone-title">
      <header className="obs-standalone__header">
        <div className="obs-standalone__heading">
          <span className="obs-standalone__icon"><ListTree aria-hidden="true" /></span>
          <div>
            <p>Scheduler governance</p>
            <h4 id="obs-standalone-title">Physical roots &amp; logical task accounting</h4>
            <span>每個實體 Scheduler 與邏輯 task 都必須被 accounting；unmapped 代表尚未完成 dependency review，不會被誤畫成 DAG。</span>
          </div>
        </div>
        <div className="obs-standalone__coverage sv-num" aria-label={`${governance?.accountedLogicalTasks ?? jobs.length} of ${governance?.uniqueLogicalTasks ?? jobs.length} logical tasks accounted for`}>
          <span><strong>{governance?.physicalRoots ?? jobs.filter((job) => job.accounting?.physicalRoot).length}</strong> physical</span>
          <ArrowRight aria-hidden="true" />
          <span><strong>{governance?.reviewedDependencies ?? mappedCount}</strong> reviewed</span>
          <span><strong>{governance?.unmappedDependencies ?? registryJobs.filter((job) => job.accounting?.accountingClass === 'unmapped_dependency').length}</strong> unmapped</span>
          <em>{governance?.accountedLogicalTasks ?? jobs.length} / {governance?.uniqueLogicalTasks ?? jobs.length} logical accounted · paused {governance?.pausedPhysicalRoots ?? 0} · bounded retry {governance?.retryEnabledPhysicalRoots ?? 0} · ticket contract {governance?.ticketContractRoots ?? 0}/{governance?.physicalRoots ?? 0} · observed {governance?.observedTicketRoots ?? 0} · terminal {governance?.terminalTicketRoots ?? 0}</em>
        </div>
      </header>

      {registryJobs.length === 0 ? (
        <div className="obs-standalone__empty">目前 API 回傳的 jobs 都已納入 execution chain。</div>
      ) : (
        <div className="obs-standalone__groups">
          {GROUP_ORDER.map((group) => {
            const groupJobs = registryJobs.filter((job) => job.group === group)
            if (!groupJobs.length) return null
            return (
              <section className="obs-standalone__group-card" key={group} aria-label={GROUP_LABEL[group]}>
                <div className="obs-standalone__group-header">
                  <div>
                    <p>{GROUP_LABEL[group]}</p>
                    <span className="sv-num">{group}</span>
                  </div>
                  <div className="obs-standalone__group-stats sv-num">
                    <span className="is-success">ok {statusCount(groupJobs, 'success')}</span>
                    <span className="is-running">run {statusCount(groupJobs, 'running')}</span>
                    <span className="is-failed">fail {statusCount(groupJobs, 'failed')}</span>
                    <strong>{groupJobs.length}</strong>
                  </div>
                </div>

                <div className="obs-standalone__job-grid">
                  {groupJobs.map((job) => {
                    const dependency = dependencyEvidence(job)
                    return (
                      <article className={`obs-standalone__job-card is-${job.lastStatus}`} key={job.id}>
                        <div className="obs-standalone__job-head">
                          <div className="obs-standalone__identity">
                            <strong>{job.name}</strong>
                            <span className="sv-num">{job.id} · {job.accounting?.physicalRoot ? `physical ${job.accounting.desiredState ?? ""}` : "logical"}</span>
                          </div>
                          <div className="obs-standalone__status">
                            <CircleDot aria-hidden="true" />
                            <span>{STATUS_LABEL[job.lastStatus]}</span>
                          </div>
                        </div>

                        <p className={`obs-standalone__summary ${job.lastError ? 'is-error' : ''}`} title={job.lastError || job.summary || undefined}>
                          {job.lastError || job.summary || '目前 API 沒有提供摘要。'}
                        </p>

                        <div className={`obs-standalone__relation ${dependency.isTopologyGap ? 'is-unmapped' : ''}`}>
                          {dependency.isTopologyGap ? <AlertTriangle aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}
                          <div>
                            <strong>{dependency.label}</strong>
                            <span>
                              {dependency.hasDependency
                                ? `up ${dependency.upstream.length} · down ${dependency.downstream.length}${typeof job.chainIndex === 'number' ? ` · index ${job.chainIndex}` : ''}`
                                : job.schedule}
                            </span>
                          </div>
                        </div>

                        <dl className="obs-standalone__timing sv-num">
                          <div><dt>Last</dt><dd>{job.lastRun || '—'}</dd></div>
                          <div><dt>Next</dt><dd>{job.nextRun || job.schedule || '—'}</dd></div>
                          <div><dt>Ticket</dt><dd>{ticketLabel(job.ticket)}</dd></div>
                        </dl>
                      </article>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
