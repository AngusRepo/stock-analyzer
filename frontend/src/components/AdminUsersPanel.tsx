/**
 * AdminUsersPanel.tsx — 使用者管理面板（僅 admin 可見）
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

const ROLE_CONFIG = {
  admin: { label: '管理員', color: 'bg-purple-100 text-purple-700', icon: ShieldCheck },
  user:  { label: '一般用戶', color: 'bg-gray-100 text-gray-600',   icon: User },
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-purple-500" />
            使用者管理
          </h2>
          {pendingCount > 0 && (
            <p className="text-xs text-amber-600 mt-0.5">
              {pendingCount} 位用戶等待審核
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} className="gap-1.5 text-xs">
          <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
          更新
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((user: any) => {
            const status  = STATUS_CONFIG[user.approval_status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.pending
            const role    = ROLE_CONFIG[user.role as keyof typeof ROLE_CONFIG] ?? ROLE_CONFIG.user
            const StatusIcon = status.icon
            const RoleIcon   = role.icon
            const isPending  = user.approval_status === 'pending'
            // 不在前端判斷誰是「系統管理者」，由後端 role 決定
            const isWayne    = user.role === 'admin' && user.id === 1  // 第一個建立的 admin

            return (
              <div
                key={user.id}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                  isPending ? 'border-amber-300/60 bg-amber-50/30 dark:bg-amber-950/10' : 'border-border/50 bg-card',
                )}
              >
                {/* Avatar */}
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name ?? ''} className="w-8 h-8 rounded-full shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{user.name ?? '未設定'}</span>
                    {isWayne && (
                      <Badge className="text-[10px] px-1 py-0 bg-purple-600 text-white">系統管理者</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                  <p className="text-[10px] text-muted-foreground">
                    申請時間：{new Date(user.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
                  </p>
                </div>

                {/* Badges */}
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', status.color)}>
                    <StatusIcon className="w-2.5 h-2.5 mr-1" />
                    {status.label}
                  </Badge>
                  <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', role.color)}>
                    <RoleIcon className="w-2.5 h-2.5 mr-1" />
                    {role.label}
                  </Badge>
                </div>

                {/* Actions */}
                {isPending && !isWayne && (
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-xs text-green-600 border-green-300 hover:bg-green-50 gap-1"
                      disabled={approveMutation.isPending}
                      onClick={() => approveMutation.mutate(user.id)}
                    >
                      <CheckCircle className="w-3 h-3" />
                      核准
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-xs text-red-500 border-red-300 hover:bg-red-50 gap-1"
                      disabled={rejectMutation.isPending}
                      onClick={() => rejectMutation.mutate(user.id)}
                    >
                      <XCircle className="w-3 h-3" />
                      拒絕
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
