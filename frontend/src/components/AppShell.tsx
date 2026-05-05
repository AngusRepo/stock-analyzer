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
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Radar,
} from 'lucide-react'
import { WorkstationBackdrop } from '@/components/workstation/WorkstationChrome'
import { prefetchWorkstationRoute } from '@/lib/queryPolicy'

const NAV_SECTIONS = [
  {
    label: 'Research',
    items: [
      { label: 'Dashboard', icon: LayoutDashboard, href: '/' },
      { label: 'Research Demo', icon: Radar, href: '/demo/research-workbench' },
    ],
  },
  {
    label: 'Decision',
    items: [
      { label: 'Bot', icon: Bot, href: '/bot' },
      { label: 'Strategy Lab', icon: FlaskConical, href: '/strategy-lab', adminOnly: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'OBS', icon: Activity, href: '/obs', adminOnly: true },
      { label: 'Pipeline', icon: GitBranch, href: '/pipeline', adminOnly: true },
      { label: 'Model Pool', icon: Boxes, href: '/model-pool', adminOnly: true },
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
      <div className="flex items-center gap-2.5 border-b border-[#263247] px-4 py-3.5">
        <div className="flex h-9 w-9 items-center justify-center border border-amber-300/45 bg-[linear-gradient(135deg,#1e1205,#06251c)] font-mono text-xs font-black text-amber-200 shadow-[0_0_22px_rgba(255,191,95,0.14)]">
          SV
        </div>
        <div>
          <span className="block font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-white">StockVision</span>
          <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-slate-500">Trading workstation</span>
        </div>
        <span className="ml-auto border border-[#263247] bg-[#070a10] px-1.5 py-0.5 font-mono text-[9px] text-amber-300">v12</span>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-3">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(item => !('adminOnly' in item && item.adminOnly) || isAdmin)
          if (!visibleItems.length) return null

          return (
            <div key={section.label}>
              <p className="px-2 pb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-[#596579]">
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
                          ? 'border-[#3b82f6]/60 bg-[linear-gradient(90deg,#07111f,#06121d)] text-white shadow-[inset_3px_0_0_#3b82f6]'
                          : 'border-transparent text-[#78859b] hover:border-[#263247] hover:bg-[#0d1118] hover:text-[#d8dee9]'
                      }`}
                    >
                      <Icon className={`h-4 w-4 ${active ? 'text-[#93c5fd] opacity-100' : 'opacity-60'}`} />
                      <span>{item.label}</span>
                      <ChevronRight className={`h-3.5 w-3.5 ${active ? 'text-[#93c5fd]' : 'text-[#445068] group-hover:text-[#d8dee9]'}`} />
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>

      <div className="border-y border-[#263247] bg-[#070a10] p-3 font-mono text-[10px] uppercase tracking-[0.13em] text-[#8a92a6]">
        <div className="mb-2 flex items-center gap-2 text-[#93c5fd]">
          <Command className="h-3.5 w-3.5" />
          Desk State
        </div>
        <p>Research ready</p>
        <p>Decision live</p>
      </div>

      <div className="border-t border-[#263247] p-3">
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
    <div className="relative flex h-screen overflow-hidden bg-[#020409] text-slate-100">
      <WorkstationBackdrop />

      <aside
        className="relative z-10 hidden shrink-0 flex-col lg:flex"
        style={{ width: 230, background: 'rgba(5,7,12,0.96)', borderRight: '1px solid #263247' }}
      >
        <SidebarNav currentPath={location} onNavigate={handleNavigate} />
      </aside>

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[230px] border-[#263247] p-0" style={{ background: '#05070c' }}>
          <SidebarNav currentPath={location} onNavigate={handleNavigate} />
        </SheetContent>
      </Sheet>

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        <div className="grid min-h-[44px] shrink-0 grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-[#263247] bg-[linear-gradient(90deg,#05070c,#08090f_55%,#120d06)] px-3">
          <Button size="icon" variant="ghost" className="h-8 w-8 lg:hidden" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-4 w-4" />
          </Button>

          <MarketTicker />

          <div className="ml-auto flex min-w-0 items-center gap-2.5">
            <div className="hidden min-w-[260px] items-center gap-2 border border-[#3a2c18] bg-[#030509] px-3 py-1.5 font-mono text-[11px] text-[#8a92a6] md:flex">
              <Command className="h-3.5 w-3.5 text-sky-300" />
              <span className="text-amber-300">/</span>
              <span className="truncate">SYMBOL / RUN_ID / INCIDENT / TOPIC</span>
              <kbd className="ml-auto border border-[#263247] bg-[#070a10] px-1 font-mono text-[9px] text-slate-400">GO</kbd>
            </div>

            {isAuthenticated && unreadCount > 0 && (
              <div className="relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center border border-[#263247] bg-[#070a10] hover:border-amber-300/40">
                <Bell className="h-[15px] w-[15px] text-[#8b8fa3]" />
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
