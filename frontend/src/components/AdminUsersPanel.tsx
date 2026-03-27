/**
 * AdminUsersPanel.tsx — 使用者管理面板（僅 admin 可見）
 * 適合窄欄顯示的緊湊卡片式排列
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CheckCircle, XCircle, Clock, ShieldCheck, User, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

const STATUS_CONFIG = {
  approved: { label: '已核准', color: 'bg-green-100 text-green-700 border-green-200',  icon: CheckCircle },
  pending:  { label: '待審核', color: 'bg-amber-100 text-amber-700  border-amber-200',  icon: Clock },
  rejected: { label: '已拒絕', color: 'bg-red-100   text-red-700    border-red-200',    icon: XCircle },
}

export function AdminUsersPanel() {
  const qc = useQueryClient()

  const { data: users = [], isLoading, refetch } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn:  () => adminApi.users(),
    staleTime: 60_000,
  })

  const approveMutation = useMutation({
    mutationFn: (userId: number) => adminApi.setStatus(userId, 'approved'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const rejectMutation = useMutation({
    mutationFn: (userId: number) => adminApi.setStatus(userId, 'rejected'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  const pendingCount = users.filter((u: any) => u.approval_status === 'pending').length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-purple-500" />
          <h2 className="text-sm font-semibold">使用者管理</h2>
          {pendingCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200">
              {pendingCount} 待審
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-6 w-6 p-0">
          <RefreshCw className={cn('w-3 h-3', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map(i => <div key={i} className="h-12 rounded-lg bg-muted/40 animate-pulse" />)}
        </div>
      ) : !users.length ? (
        <p className="text-xs text-muted-foreground text-center py-4">尚無使用者</p>
      ) : (
        <div className="space-y-1.5">
          {users.map((user: any) => {
            const status = STATUS_CONFIG[user.approval_status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.pending
            const StatusIcon = status.icon
            const isPending = user.approval_status === 'pending'
            const isFirstAdmin = user.role === 'admin' && user.id === 1

            return (
              <div
                key={user.id}
                className={cn(
                  'flex items-center gap-2 p-2 rounded-lg border transition-colors',
                  isPending ? 'border-amber-300/60 bg-amber-950/10' : 'border-white/[0.06] bg-white/[0.02]',
                )}
              >
                {/* Avatar */}
                {user.avatar ? (
                  <img src={user.avatar} alt="" className="w-7 h-7 rounded-full shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{user.name ?? '未設定'}</span>
                    {isFirstAdmin && (
                      <Badge className="text-[8px] px-1 py-0 bg-purple-600 text-white leading-tight">Owner</Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{user.email}</p>
                </div>

                {/* Status + Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {isPending && !isFirstAdmin ? (
                    <>
                      <Button
                        size="sm" variant="outline"
                        className="h-6 w-6 p-0 text-green-600 border-green-300 hover:bg-green-50"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate(user.id)}
                        title="核准"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        className="h-6 w-6 p-0 text-red-500 border-red-300 hover:bg-red-50"
                        disabled={rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate(user.id)}
                        title="拒絕"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  ) : (
                    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', status.color)}>
                      <StatusIcon className="w-2.5 h-2.5 mr-0.5" />
                      {status.label}
                    </Badge>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
