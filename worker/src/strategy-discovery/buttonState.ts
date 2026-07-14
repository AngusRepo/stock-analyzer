import type { AnalysisRunRecord, DashboardState } from './domain'

export interface ButtonStateInput {
  latestRun: AnalysisRunRecord | null
  blockers: string[]
  staleWorkflow: boolean
  bundleReady: boolean
  resultReady: boolean
  artifactMismatch: boolean
}

export function recoverableLatestRun(state: Pick<DashboardState, 'analysis_button' | 'latest_run'>): AnalysisRunRecord | null {
  return state.analysis_button.state === 'FAILED_RECOVERABLE' ? state.latest_run : null
}

export function resolveButtonState(input: ButtonStateInput): Pick<DashboardState, 'analysis_button' | 'codex_button'> {
  const run = input.latestRun
  if (input.blockers.length) {
    return {
      analysis_button: { enabled: false, state: 'BLOCKED', message: input.blockers.join('；') },
      codex_button: { enabled: false, state: 'NOT_READY', message: '請先排除完整分析 blockers' },
    }
  }
  if (!run) {
    return {
      analysis_button: { enabled: true, state: 'READY', message: '可使用目前快照執行完整分析' },
      codex_button: { enabled: false, state: 'NOT_READY', message: '完整分析尚未完成' },
    }
  }
  if (input.staleWorkflow || input.artifactMismatch || run.status === 'FAILED_RECOVERABLE') {
    return {
      analysis_button: { enabled: true, state: 'FAILED_RECOVERABLE', message: '從最後成功 checkpoint 繼續' },
      codex_button: { enabled: false, state: 'NOT_READY', message: input.artifactMismatch ? 'Jury Bundle artifact 不一致，請先恢復分析' : '完整分析尚未恢復完成' },
    }
  }
  if (['CREATED', 'PREFLIGHT', 'RUNNING'].includes(run.status)) {
    return {
      analysis_button: { enabled: false, state: 'RUNNING', message: `完整分析進行中；目前階段：${run.current_step ?? 'preflight'}；已完成：${run.completed_steps} / ${run.total_steps}` },
      codex_button: { enabled: false, state: 'NOT_READY', message: '請先完成完整分析' },
    }
  }
  if (input.resultReady || run.status === 'RESULT_READY') {
    return {
      analysis_button: { enabled: true, state: 'COMPLETED', message: '可使用目前最新資料建立新的 Run' },
      codex_button: { enabled: true, state: 'RESULT_READY', message: '開啟完整 Codex 結論' },
    }
  }
  if (input.bundleReady && run.status === 'AWAITING_RESULT') {
    return {
      analysis_button: { enabled: true, state: 'COMPLETED', message: '可使用目前最新資料建立新的 Run' },
      codex_button: { enabled: true, state: 'AWAITING_RESULT', message: '等待 codex-result.zip' },
    }
  }
  if (input.bundleReady || ['CLOUD_ANALYSIS_COMPLETE', 'CODEX_HANDOFF_READY'].includes(run.status)) {
    return {
      analysis_button: { enabled: true, state: 'COMPLETED', message: '可使用目前最新資料建立新的 Run' },
      codex_button: { enabled: true, state: 'HANDOFF_READY', message: '開啟 Codex 交接面板' },
    }
  }
  return {
    analysis_button: { enabled: false, state: 'BLOCKED', message: 'Run 狀態與 artifact 不一致' },
    codex_button: { enabled: false, state: 'NOT_READY', message: 'Codex Bundle 尚未建立' },
  }
}
