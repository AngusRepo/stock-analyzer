import { AlertTriangle, ArrowRight, CalendarClock, CircleDot, ListTree } from 'lucide-react'
import type { SchedulerJob } from '@/lib/api'
import './StandaloneJobRegistry.css'

const GROUP_LABEL: Record<SchedulerJob['group'], string> = {
  pipeline_chain: 'Pipeline support',
  intraday: 'Intraday roots',
  daily: 'Daily operations',
  weekly: 'Weekly operations',
  monthly: 'Monthly operations',
}

const GROUP_ORDER: SchedulerJob['group'][] = ['pipeline_chain', 'intraday', 'daily', 'weekly', 'monthly']

const STATUS_LABEL: Record<SchedulerJob['lastStatus'], string> = {
  success: 'Completed',
  failed: 'Failed',
  running: 'Running',
  waiting: 'Waiting',
  sleep: 'Not in window',
  skip: 'Skipped',
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
  return { upstream, downstream, hasDependency }
}

export default function StandaloneJobRegistry({
  jobs,
  mappedJobIds,
}: {
  jobs: SchedulerJob[]
  mappedJobIds: ReadonlySet<string>
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
            <p>Runtime registry</p>
            <h4 id="obs-standalone-title">Standalone &amp; unmapped jobs</h4>
            <span>沒有真實 dependency 的 job 留在清單；有 dependency 但尚未畫進 chain 的 job 會明確標示。</span>
          </div>
        </div>
        <div className="obs-standalone__coverage sv-num" aria-label={`${jobs.length} scheduler jobs accounted for`}>
          <span><strong>{mappedCount}</strong> chain</span>
          <ArrowRight aria-hidden="true" />
          <span><strong>{registryJobs.length}</strong> registry</span>
          <em>{jobs.length} / {jobs.length} accounted</em>
        </div>
      </header>

      {registryJobs.length === 0 ? (
        <div className="obs-standalone__empty">目前正式 API 回傳的 jobs 都已納入可視 chain。</div>
      ) : (
        <div className="obs-standalone__groups">
          {GROUP_ORDER.map((group) => {
            const groupJobs = registryJobs.filter((job) => job.group === group)
            if (!groupJobs.length) return null
            return (
              <section className="obs-standalone__group" key={group} aria-label={GROUP_LABEL[group]}>
                <div className="obs-standalone__group-label">
                  <span>{GROUP_LABEL[group]}</span>
                  <strong className="sv-num">{groupJobs.length}</strong>
                </div>
                <div className="obs-standalone__rows">
                  {groupJobs.map((job) => {
                    const dependency = dependencyEvidence(job)
                    return (
                      <article className={`obs-standalone__row is-${job.lastStatus}`} key={job.id}>
                        <div className="obs-standalone__status">
                          <CircleDot aria-hidden="true" />
                          <span>{STATUS_LABEL[job.lastStatus]}</span>
                        </div>
                        <div className="obs-standalone__identity">
                          <strong>{job.name}</strong>
                          <span className="sv-num">{job.id}</span>
                          <p>{job.summary || '正式 API 尚未提供執行摘要。'}</p>
                        </div>
                        <div className={`obs-standalone__relation ${dependency.hasDependency ? 'is-unmapped' : ''}`}>
                          {dependency.hasDependency ? <AlertTriangle aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}
                          <div>
                            <strong>{dependency.hasDependency ? 'Unmapped dependency' : 'Standalone root'}</strong>
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
