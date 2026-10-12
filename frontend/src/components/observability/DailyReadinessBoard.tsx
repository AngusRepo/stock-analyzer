import { useState, type ReactNode } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import { DAILY_READINESS_PHASES, READINESS_MAIN_STAGES } from './dailyReadinessPhases'
import './DailyReadinessBoard.css'

export type ReadinessStageView = { label: string; status: string; statusLabel: string; date?: string | null }
const PHASE_CONTEXT: Record<string, string> = {
  sources: '收盤後 · 資料與風險就緒',
  models: '夜間 · L3 封存後等待盤前',
  premarket: '次交易日 · US / News 匯合後 07:15 接續',
  evidence: 'L4 回傳後 · 驗證與全鏈收據',
}
export default function DailyReadinessBoard({ stageView, renderStage, pipelineSummary }: {
  pipelineSummary?: string;
  stageView: (id: string) => ReadinessStageView;
  renderStage: (id: string, ordinal: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const renderNode = (id: string, index: number) => <div key={id} className="daily-readiness-board__stage"
    data-pipeline-child={['ml-predict', 'recommendation'].includes(id) ? id : undefined}>
    {renderStage(id, String(index + 1).padStart(2, '0'))}
  </div>
  const expandedPhase = DAILY_READINESS_PHASES.find(phase => phase.id === expanded)
  return <div className="daily-readiness-board">
    <div className="daily-readiness-board__phases" aria-label="Daily readiness 跨日執行順序">
      {DAILY_READINESS_PHASES.map((phase, index) => {
        const views = phase.stages.map(id => ({ id, ...stageView(id) }))
        const running = views.filter(view => view.status === 'running')
        const completed = views.filter(view => ['completed', 'noop'].includes(view.status)).length
        const main = READINESS_MAIN_STAGES[phase.id]
        const supporting = views.filter(view => !main.includes(view.id))
        const attention = supporting.filter(view => ['running', 'blocked'].includes(view.status))
        return <section key={phase.id} aria-labelledby={'daily-phase-' + phase.id}
          className={'daily-readiness-board__phase is-' + phase.id} title={phase.id === 'models' ? pipelineSummary : undefined}>
          <div className="daily-readiness-board__phase-info"><header className="daily-readiness-board__phase-title">
            <span className="daily-readiness-board__number">0{index + 1}</span><h4 id={'daily-phase-' + phase.id}>{phase.title}</h4>
            <span className="daily-readiness-board__phase-state">
              {running.length > 0 && <LoaderCircle className="daily-readiness-board__running" aria-label={running.length + ' 項執行中'} />}
              <span>{completed}/{views.length}</span>
            </span>
          </header>
          <p className="daily-readiness-board__caption">{PHASE_CONTEXT[phase.id]}</p>


          <button type="button" className={'daily-readiness-board__more' + (attention.length ? ' has-attention' : '')}
            aria-expanded={expanded === phase.id} aria-controls="daily-readiness-supporting"
            onClick={() => setExpanded(expanded === phase.id ? null : phase.id)}>
            <span>相關產物與監測 · {supporting.length}</span><span>{attention.length ? `${attention.length} 項需關注` : '查看'}<ChevronDown aria-hidden="true" /></span>
          </button></div>
          <div className="daily-readiness-board__stages">{main.map(renderNode)}</div>
        </section>
      })}
    </div>
    <section id="daily-readiness-supporting" className="daily-readiness-board__supporting" hidden={!expandedPhase}>
      {expandedPhase && <><h4>{expandedPhase.title} · 相關產物與監測</h4>
        <p className="daily-readiness-board__caption">各自依事件或排程執行，狀態保留各自業務日。</p>
        <div className="daily-readiness-board__stages">{expandedPhase.stages.filter(id => !READINESS_MAIN_STAGES[expandedPhase.id].includes(id)).map(renderNode)}</div></>}
    </section>
  </div>
}
