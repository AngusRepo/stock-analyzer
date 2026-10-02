import { useEffect, useState, type ReactNode } from 'react'
import { DAILY_READINESS_PHASES, dailyPhaseForStage } from './dailyReadinessPhases'
import './DailyReadinessBoard.css'

export type ReadinessStageView = { label: string; status: string; statusLabel: string; date?: string | null }

export default function DailyReadinessBoard({ currentId, selectedId, stageView, renderStage }: {
  currentId: string; selectedId: string | null;
  stageView: (id: string) => ReadinessStageView;
  renderStage: (id: string, ordinal: string) => ReactNode;
}) {
  const [phaseId, setPhaseId] = useState(() => dailyPhaseForStage(selectedId ?? currentId) ?? 'sources')
  // Follow an explicitly selected/live stage, without resetting a user browsing another group on each poll.
  useEffect(() => {
    const next = dailyPhaseForStage(selectedId ?? currentId)
    if (next) setPhaseId(next)
  }, [selectedId, currentId])
  const phase = DAILY_READINESS_PHASES.find(item => item.id === phaseId) ?? DAILY_READINESS_PHASES[0]

  return <div className="daily-readiness-board">
    <div className="daily-readiness-board__phases" role="tablist" aria-label="Daily readiness 階段">
      {DAILY_READINESS_PHASES.map((item, index) => {
        const views = item.stages.map(id => ({ id, ...stageView(id) }))
        const attention = views.find(view => view.status === 'blocked') ?? views.find(view => view.status === 'running')
          ?? views.find(view => view.status === 'waiting')
        const completed = views.filter(view => ['completed', 'noop'].includes(view.status)).length
        const tone = attention?.status ?? (completed === views.length ? 'completed' : 'not_started')
        const previews = item.id === 'premarket' ? views.filter(view => ['us-leading', 'news-analyst', 'pre-market-warmup'].includes(view.id)) : []
        return <button type="button" role="tab" id={`daily-phase-${item.id}`} aria-controls="daily-phase-panel"
          aria-selected={phase.id === item.id} tabIndex={phase.id === item.id ? 0 : -1} key={item.id}
          onKeyDown={event => {
            const n=DAILY_READINESS_PHASES.length
            const target=event.key==='Home' ? 0 : event.key==='End' ? n-1
              : event.key==='ArrowRight' ? (index+1)%n : event.key==='ArrowLeft' ? (index+n-1)%n : null
            if(target==null) return
            event.preventDefault()
            const id=DAILY_READINESS_PHASES[target].id
            setPhaseId(id)
            document.getElementById(`daily-phase-${id}`)?.focus()
          }}
          className={`daily-readiness-board__phase is-${tone} ${phase.id === item.id ? 'is-selected' : ''}`}
          onClick={() => setPhaseId(item.id)}>
          <span className="daily-readiness-board__phase-title"><small>0{index + 1}</small><strong>{item.title}</strong><em>{completed}/{views.length}</em></span>
          <span className="daily-readiness-board__caption">{item.caption}</span>
          {previews.length ? <span className="daily-readiness-board__preview">{previews.map(view =>
            <span key={view.id} className={`is-${view.status}`}>{view.label}<b>{view.statusLabel}</b></span>)}</span>
            : <span className="daily-readiness-board__attention">{attention ? `${attention.label} · ${attention.statusLabel}` : completed === views.length ? '階段工作已完成' : '查看各項執行狀態'}</span>}
        </button>
      })}
    </div>
    <section id="daily-phase-panel" role="tabpanel" aria-labelledby={`daily-phase-${phase.id}`}>
      <header className="daily-readiness-board__panel-head"><div><h4>{phase.title}</h4>
        <p>按階段查看；各項日期依原始執行收據呈現。</p></div><span>{phase.stages.length} 項工作</span></header>
      <div className="daily-readiness-board__stages">{phase.stages.map((id, index) =>
        <div key={id} className="daily-readiness-board__stage">{renderStage(id, String(index + 1).padStart(2, '0'))}
          <span className="daily-readiness-board__date">資料日 {stageView(id).date ?? '尚無收據'}</span></div>)}</div>
    </section>
  </div>
}
