import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost } from '@/lib/apiClient'
import { useState } from 'react'

type State = {
  status: string; reason?: string | null; durable_pause?: boolean
  receipt?: { sha256?: string; action?: string } | null
}
const key = ['execution', 'submission-state']

export function ExecutionPaperReturn() {
  const cache = useQueryClient()
  const [notice, setNotice] = useState('')
  const state = useQuery({ queryKey: key, queryFn: () => apiGet<State>('/admin/execution/submission-state'), retry: false })
  // Only a durable pause row counts as stopped. A lapsed resume (approval env missing,
  // changed or expired) is closed for now but would reopen if the env came back.
  const confirmed = state.data?.status === 'live_submission_paused' && state.data.durable_pause === true
    && state.data.receipt?.action === 'pause' && !!state.data.receipt.sha256
  const lapsed = state.data?.status === 'live_submission_paused' && !confirmed && state.data.receipt?.action === 'resume'
  const stop = useMutation({
    mutationFn: () => apiPost<State>('/admin/execution/return-to-paper', { request_id: crypto.randomUUID() }),
    retry: false,
    onSuccess: (result) => {
      if (result.status === 'live_submission_paused' && result.receipt?.action === 'pause' && result.receipt.sha256) {
        cache.setQueryData(key, { ...result, durable_pause: true })
        setNotice('已停止新 Live 買單與賣單；已送出的委託持續對帳。')
      } else setNotice('停止尚未確認，請重新讀取狀態。')
    },
    onError: () => setNotice('停止尚未確認，請重新讀取狀態。'),
  })
  return <div className="mt-3 rounded-lg border border-amber-400/30 p-3 text-sm">
    <p>Live 委託控制：{confirmed ? '已停止'
      : lapsed ? '暫時關閉（核准失效，尚未寫入停止紀錄）'
      : state.data?.status === 'live_submission_open' ? '實盤送單中' : '狀態待確認'}</p>
    <p className="mt-1 text-xs text-muted-foreground">退回 Paper 會保留既有 Live 掛單與持倉，持續對帳，由人工管理。</p>
    <div className="mt-2 flex flex-wrap gap-3">
      <button type="button" disabled={stop.isPending || confirmed} onClick={() => stop.mutate()}
        className="rounded border border-amber-400/60 px-3 py-1.5 text-amber-200 disabled:opacity-50">
        {stop.isPending ? '正在停止…' : '停止 Live 新委託，退回 Paper'}
      </button>
      <button type="button" onClick={() => void state.refetch()} className="text-xs underline">重新讀取狀態</button>
    </div>
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
  </div>
}
