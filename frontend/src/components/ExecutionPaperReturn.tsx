import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost } from '@/lib/apiClient'
import { useState } from 'react'

type State = { status: string; receipt?: { sha256?: string } }
const key = ['execution', 'submission-state']

export function ExecutionPaperReturn() {
  const cache = useQueryClient()
  const [notice, setNotice] = useState('')
  const state = useQuery({ queryKey: key, queryFn: () => apiGet<State>('/admin/execution/submission-state'), retry: false })
  const confirmed = state.data?.status === 'live_submission_paused' && !!state.data.receipt?.sha256
  const stop = useMutation({
    mutationFn: () => apiPost<State>('/admin/execution/return-to-paper', { request_id: crypto.randomUUID() }),
    retry: false,
    onSuccess: (result) => {
      if (result.status === 'live_submission_paused' && result.receipt?.sha256) {
        cache.setQueryData(key, result)
        setNotice('已停止新 Live 委託與後續分單。')
      } else setNotice('停止尚未確認，請重新讀取狀態。')
    },
    onError: () => setNotice('停止尚未確認，請重新讀取狀態。'),
  })
  return <div className="mt-3 rounded-lg border border-amber-400/30 p-3 text-sm">
    <p>Live 委託控制：{confirmed ? '已停止' : state.data?.status === 'not_paused' ? '未設定停止' : '狀態待確認'}</p>
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
