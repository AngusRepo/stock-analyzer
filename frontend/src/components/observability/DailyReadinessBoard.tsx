import type { ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { DAILY_READINESS_PHASES } from './dailyReadinessPhases'
import './DailyReadinessBoard.css'

export type ReadinessStageView = { label: string; status: string; statusLabel: string; date?: string | null }

export default function DailyReadinessBoard({ stageView, renderStage }: {
  stageView: (id: string) => ReadinessStageView;
  renderStage: (id: string, ordinal: string) => ReactNode;
}) {
  return <div className="daily-readiness-board">
    <div className="daily-readiness-board__phases" aria-label="Daily readiness 四階段">
      {DAILY_READINESS_PHASES.map((phase, index) => {
        const views = phase.stages.map(id => ({ id, ...stageView(id) }))
        const running = views.filter(view => view.status === 'running')
        const blocked = views.some(view => view.status === 'blocked')
        const completed = views.filter(view => ['completed', 'noop'].includes(view.status)).length
        return <section key={phase.id} aria-labelledby={`daily-phase-${phase.id}`}
          className={`daily-readiness-board__phase is-${phase.id} ${running.length ? 'is-running' : ''} ${blocked ? 'is-blocked' : ''}`}>
          <header className="daily-readiness-board__phase-title">
            <small>0{index + 1}</small><h4 id={`daily-phase-${phase.id}`}>{phase.title}</h4>
            <span className="daily-readiness-board__phase-state">
              {running.length > 0 && <span className="daily-readiness-board__running" role="status"
                aria-label={`${running.length} 項執行中`} title={running.map(view => view.label).join('、')}>
                <LoaderCircle aria-hidden="true" /></span>}
              <span className="sv-num">{completed}/{views.length}</span>
            </span>
          </header>
          <p className="daily-readiness-board__caption">{phase.caption}</p>
          <div className="daily-readiness-board__stages">{views.map((view, stageIndex) =>
            <div key={view.id} className="daily-readiness-board__stage">
              {renderStage(view.id, String(stageIndex + 1).padStart(2, '0'))}
            </div>)}</div>
        </section>
      })}
    </div>
  </div>
}
