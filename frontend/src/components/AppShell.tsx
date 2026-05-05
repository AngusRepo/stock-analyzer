import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import { marketApi, notificationsApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import {
  Activity,
  Bell,
  Bot,
  Boxes,
  ChevronRight,
  Command,
  FlaskConical,
  GitBranch,
  Home,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
} from 'lucide-react'
import { WorkstationBackdrop } from '@/components/workstation/WorkstationChrome'
import { prefetchWorkstationRoute } from '@/lib/queryPolicy'

const NAV_SECTIONS = [
  {
    label: '每日',
    items: [
      { label: '晨間概覽', icon: LayoutDashboard, href: '/' },
    ],
  },
  {
    label: '行動',
    items: [
      { label: '模擬交易室', icon: Bot, href: '/bot' },
      { label: '策略實驗室', icon: FlaskConical, href: '/strategy-lab', adminOnly: true },
    ],
  },
  {
    label: '監控',
    items: [
      { label: 'Observability', icon: Activity, href: '/obs', adminOnly: true },
      { label: '流程追蹤', icon: GitBranch, href: '/pipeline', adminOnly: true },
      { label: '模型池', icon: Boxes, href: '/model-pool', adminOnly: true },
    ],
  },
] as const

function isActivePath(itemHref: string, currentPath: string) {
  if (itemHref === '/') return currentPath === '/' || currentPath.startsWith('/stock/')
  return currentPath === itemHref || currentPath.startsWith(`${itemHref}/`)
}

function MarketTicker() {
  const { data, isLoading } = useQuery({
    queryKey: ['market', 'indices'],
    queryFn: marketApi.indices,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 3 * 60 * 1000,
  })

  if (isLoading || (!data?.twii && !data?.twoii)) {
    return (
      <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
        <span>TWII --</span>
        <span>OTC --</span>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-5 overflow-hidden font-mono text-[11px]">
      {[data?.twii, data?.twoii].filter(Boolean).map((idx: any) => {
        const up = idx.change >= 0
        return (
          <div key={idx.name} className="flex shrink-0 items-center gap-1.5">
            <span className="text-[#8a92a6]">{idx.name}</span>
            <span className="font-semibold text-slate-200">
              {idx.current?.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={up ? 'text-rose-300' : 'text-emerald-300'}>
              {up ? '+' : ''}{idx.change?.toFixed(2)} ({up ? '+' : ''}{idx.changePct?.toFixed(2)}%)
            </span>
          </div>
        )
      })}
    </div>
  )
}

function FocusBar({ currentPath, unreadCount }: { currentPath: string; unreadCount: number }) {
  const area = currentPath.startsWith('/bot')
      ? '模擬交易室'
      : currentPath.startsWith('/obs') || currentPath.startsWith('/pipeline') || currentPath.startsWith('/scheduler') || currentPath.startsWith('/data-quality')
        ? '可觀測性'
        : '晨間概覽'

  return (
    <div className="hidden min-w-0 items-center gap-2 rounded-full border border-[#2b3a49] bg-[#111821]/88 px-3 py-1.5 text-[11px] text-[#9badbf] shadow-[0_8px_28px_rgba(0,0,0,0.18)] xl:flex">
      <Home className="h-3.5 w-3.5 text-[#7aa2c7]" />
      <span className="font-medium text-[#e6edf3]">今日焦點</span>
      <span className="h-1 w-1 rounded-full bg-[#4f6f8f]" />
      <span className="truncate">目前在 {area}</span>
      <span className="h-1 w-1 rounded-full bg-[#4f6f8f]" />
      <span className="truncate">{unreadCount > 0 ? `${unreadCount} 則提醒待看` : '沒有新提醒'}</span>
    </div>
  )
}

function SidebarNav({ currentPath, onNavigate }: { currentPath: string; onNavigate: (href: string) => void }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const isAdmin = user?.role === 'admin'
  const isAuthenticated = Boolean(user)

  const prefetchRoute = (href: string) => {
    prefetchWorkstationRoute(queryClient, href, { isAuthenticated, isAdmin })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-[#2b3a49] px-4 py-3.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#7aa2c7]/45 bg-[linear-gradient(135deg,#17202b,#0f2835)] font-mono text-xs font-black text-[#d8e7f5] shadow-[0_0_22px_rgba(122,162,199,0.14)]">
          SV
        </div>
        <div>
          <span className="block font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-[#e6edf3]">StockVision</span>
          <span className="block text-[10px] text-[#8b9bab]">我的量化投資伴侶</span>
        </div>
        <span className="ml-auto rounded-full border border-[#2b3a49] bg-[#111821] px-1.5 py-0.5 font-mono text-[9px] text-[#7aa2c7]">v12</span>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(item => !('adminOnly' in item && item.adminOnly) || isAdmin)
          if (!visibleItems.length) return null

          return (
            <div key={section.label}>
              <p className="px-2 pb-1.5 text-[10px] font-semibold tracking-[0.16em] text-[#75879a]">
                {section.label}
              </p>
              <div className="space-y-1">
                {visibleItems.map((item) => {
                  const Icon = item.icon
                  const active = isActivePath(item.href, currentPath)
                  return (
                    <button
                      key={item.label}
                      onFocus={() => prefetchRoute(item.href)}
                      onMouseEnter={() => prefetchRoute(item.href)}
                      onClick={() => onNavigate(item.href)}
                      className={`group grid w-full grid-cols-[24px_1fr_14px] items-center gap-2 border px-3 py-2.5 text-left font-mono text-[12px] transition-all ${
                        active
                          ? 'rounded-xl border-[#7aa2c7]/50 bg-[linear-gradient(90deg,#122334,#101821)] text-[#e6edf3] shadow-[inset_3px_0_0_#7aa2c7]'
                          : 'rounded-xl border-transparent text-[#8b9bab] hover:border-[#2b3a49] hover:bg-[#111821] hover:text-[#e6edf3]'
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${active ? 'text-[#9cc7ef] opacity-100' : 'opacity-60'}`} />
                      <span>{item.label}</span>
                      <ChevronRight className={`h-3.5 w-3.5 ${active ? 'text-[#9cc7ef]' : 'text-[#566574] group-hover:text-[#e6edf3]'}`} />
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      <div className="border-y border-[#2b3a49] bg-[#0f151d] p-3 text-[11px] text-[#8b9bab]">
        <div className="mb-2 flex items-center gap-2 text-[#7aa2c7]">
          <Command className="h-3.5 w-3.5" />
          今天的路徑
        </div>
        <p>先判讀市場，再進研究室拆題材</p>
        <p>執行前回到 Observability 確認可信度</p>
      </div>

      <div className="border-t border-[#2b3a49] p-3">
        <UserSection />
      </div>
    </div>
  )
}

function UserSection() {
  const { user, isAuthenticated, login, logout } = useAuth()

  if (!isAuthenticated) {
    return (
      <Button variant="outline" size="sm" className="w-full gap-2 text-xs" onClick={login}>
        <LogIn className="h-3.5 w-3.5" /> Google 登入
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[linear-gradient(135deg,#ffbf5f,#4cc9ff)] text-[11px] font-bold text-slate-950">
        {user?.name?.[0] ?? 'U'}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-semibold">{user?.name}</p>
        <p className="truncate text-[10px] text-slate-500">{user?.role ?? 'user'}</p>
      </div>
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={logout}>
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { isAuthenticated } = useAuth()

  const { data: notifCount } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: notificationsApi.count,
    enabled: isAuthenticated,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const unreadCount = notifCount?.count ?? 0

  const handleNavigate = (href: string) => {
    setLocation(href)
    setSidebarOpen(false)
  }

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#0b0f14] text-[#e6edf3]">
      <WorkstationBackdrop />

      <aside
        className="relative z-10 hidden shrink-0 flex-col lg:flex"
        style={{ width: 230, background: 'rgba(12,17,23,0.96)', borderRight: '1px solid #2b3a49' }}
      >
        <SidebarNav currentPath={location} onNavigate={handleNavigate} />
      </aside>

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[230px] border-[#2b3a49] p-0" style={{ background: '#0c1117' }}>
          <SidebarNav currentPath={location} onNavigate={handleNavigate} />
        </SheetContent>
      </Sheet>

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        <div className="grid min-h-[48px] shrink-0 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-[#2b3a49] bg-[linear-gradient(90deg,#0c1117,#111821_58%,#0d1722)] px-3">
          <Button size="icon" variant="ghost" className="h-8 w-8 lg:hidden" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-4 w-4" />
          </Button>

          <MarketTicker />

          <div className="ml-auto flex min-w-0 items-center gap-2.5">
            <FocusBar currentPath={location} unreadCount={unreadCount} />
            <div className="hidden min-w-[250px] items-center gap-2 rounded-full border border-[#2b3a49] bg-[#0b0f14] px-3 py-1.5 font-mono text-[11px] text-[#8b9bab] md:flex">
              <Command className="h-3.5 w-3.5 text-[#7aa2c7]" />
              <span className="text-[#7aa2c7]">/</span>
              <span className="truncate">標的 / 任務 / 監控狀態</span>
              <kbd className="ml-auto rounded border border-[#2b3a49] bg-[#111821] px-1 font-mono text-[9px] text-[#9badbf]">GO</kbd>
            </div>

            {isAuthenticated && unreadCount > 0 && (
              <div className="relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full border border-[#2b3a49] bg-[#111821] hover:border-[#7aa2c7]/45">
                <Bell className="h-[15px] w-[15px] text-[#9badbf]" />
                <span className="absolute right-1 top-1 h-[5px] w-[5px] rounded-full bg-red-500" />
              </div>
            )}
          </div>
        </div>

        <main className="relative z-10 flex-1 overflow-y-auto bg-transparent">
          {children}
        </main>
      </div>
    </div>
  )
}
