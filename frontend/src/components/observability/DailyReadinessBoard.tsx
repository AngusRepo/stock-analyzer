import type { ReactNode } from 'react'
import { ArrowDown, ChevronDown, LoaderCircle } from 'lucide-react'
import { DAILY_READINESS_PHASES, READINESS_MAIN_STAGES } from './dailyReadinessPhases'
import './DailyReadinessBoard.css'

export type ReadinessStageView = { label: string; status: string; statusLabel: string; date?: string | null }
export default function DailyReadinessBoard({ stageView, renderStage, pipelineSummary }: {
  pipelineSummary?: string;
  stageView: (id: string) => ReadinessStageView;
  renderStage: (id: string, ordinal: string) => ReactNode;
}) {
  const renderNode = (id: string, index: number) => <div key={id} className="daily-readiness-board__stage"
    data-pipeline-child={['ml-predict', 'recommendation'].includes(id) ? id : undefined}>
    {renderStage(id, String(index + 1).padStart(2, '0'))}
  </div>
  return <div className="daily-readiness-board">
    <div className="daily-readiness-board__phases" aria-label="Daily readiness 跨日執行順序">
      {DAILY_READINESS_PHASES.map((phase, index) => {
        const views = phase.stages.map(id => ({ id, ...stageView(id) }))
        const running = views.filter(view => view.status === 'running')
        const completed = views.filter(view => ['completed', 'noop'].includes(view.status)).length
        const main = READINESS_MAIN_STAGES[phase.id]
        const supporting: readonly string[] = phase.stages.filter(id => !main.includes(id))
        const attention = views.filter(view => supporting.includes(view.id) && ['running', 'blocked'].includes(view.status))
        return <section key={phase.id} aria-labelledby={'daily-phase-' + phase.id}
          className={'daily-readiness-board__phase is-' + phase.id}>
          {phase.id === 'premarket' && <div className="daily-readiness-board__handoff" role="note">
            <ArrowDown aria-hidden="true" /><div><strong>次交易日盤前接續</strong>
              <p>{pipelineSummary || 'L3 封存後等待盤前資料；等待事件不代表持續運算。'}</p>
            </div>
          </div>}
          <header className="daily-readiness-board__phase-title">
            <small className="sv-num">0{index + 1}</small><h4 id={'daily-phase-' + phase.id}>{phase.title}</h4>
            <span className="daily-readiness-board__phase-state">
              {running.length > 0 && <span className="daily-readiness-board__running" role="status"
                aria-label={running.length + ' 項執行中'}><LoaderCircle aria-hidden="true" /></span>}
              <span className="sv-num">{completed}/{views.length}</span>
            </span>
          </header>
          <p className="daily-readiness-board__caption">{phase.caption}</p>
          {phase.id === 'premarket' ? <>
            <div className="daily-readiness-board__stages">{main.slice(0, 2).map(renderNode)}</div>
            <p className="daily-readiness-board__join"><ArrowDown aria-hidden="true" />兩路資料就緒且已到 07:15，接續整備與 L4</p>
            <div className="daily-readiness-board__stages">{main.slice(2).map((id, i) => renderNode(id, i + 2))}</div>
          </> : <div className="daily-readiness-board__stages">{main.map(renderNode)}</div>}
          {phase.id === 'models' && <p className="daily-readiness-board__caption">{pipelineSummary}</p>}
          {supporting.length > 0 && <details className="daily-readiness-board__supporting" open={attention.length > 0 || undefined}>
            <summary><ChevronDown aria-hidden="true" /><span>相關產物與監測</span>
              <span>{supporting.length} 項{attention.length ? ' · ' + attention.length + ' 項需關注' : ''}</span></summary>
            <p className="daily-readiness-board__caption">各自依事件或排程執行，不表示彼此串行。</p>
            <div className="daily-readiness-board__stages">{supporting.map(renderNode)}</div>
          </details>}
        </section>
      })}
    </div>
  </div>
}
