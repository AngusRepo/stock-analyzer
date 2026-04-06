/**
 * AppShell — Shared layout for Dashboard & BotDashboard
 *
 * Structure:
 *   ┌──────────┬──────────────────────────────┐
 *   │ Sidebar  │  Topbar (market ticker)      │
 *   │ (220px)  ├──────────────────────────────┤
 *   │ nav +    │  children (page content)     │
 *   │ user     │                              │
 *   └──────────┴──────────────────────────────┘
 *
 * Mobile: sidebar collapses to Sheet (hamburger toggle)
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import { marketApi, notificationsApi } from '@/lib/api'
import { useAuth } from '@/_core/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import {
  LayoutDashboard, Bot, Menu,
  Bell, Search, LogIn, LogOut,
} from 'lucide-react'

// ── Nav items ─────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { label: 'Dashboard', icon: LayoutDashboard, href: '/' },
  { label: 'Bot Trading', icon: Bot, href: '/bot' },
] as const

// ── Market Ticker ─────────────────────────────────────────────────────────────
function MarketTicker() {
  const { data, isLoading } = useQuery({
    queryKey: ['market', 'indices'],
    queryFn: marketApi.indices,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 3 * 60 * 1000,
  })

  if (isLoading || (!data?.twii && !data?.twoii)) return null

  return (
    <>
      {[data?.twii, data?.twoii].filter(Boolean).map((idx: any) => {
        const up = idx.change >= 0
        return (
          <div key={idx.name} className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium">{idx.name}</span>
            <span className="font-mono font-semibold text-[12px]">
              {idx.current?.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={`font-mono text-[11px] ${up ? 'text-red-400' : 'text-emerald-400'}`}>
              {up ? '+' : ''}{idx.change?.toFixed(2)} ({up ? '+' : ''}{idx.changePct?.toFixed(2)}%)
            </span>
          </div>
        )
      })}
    </>
  )
}

// ── Sidebar Content ──────────────────────────────────────────────────────────
function SidebarNav({ currentPath, onNavigate }: { currentPath: string; onNavigate: (href: string) => void }) {
  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-[var(--sv-bg-3)]">
        <div className="w-[30px] h-[30px] rounded-lg flex items-center justify-center font-extrabold text-xs text-[#0a0b0f]"
             style={{ background: 'linear-gradient(135deg, #00d4aa, #3b82f6)' }}>
          SV
        </div>
        <span className="font-bold text-[15px] tracking-tight">StockVision</span>
        <span className="ml-auto text-[9px] text-muted-foreground bg-[var(--sv-bg-3)] px-1.5 py-0.5 rounded">v12</span>
      </div>

      {/* Nav Items */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = item.href === currentPath
          return (
            <button
              key={item.label}
              onClick={() => onNavigate(item.href)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all border ${
                active
                  ? 'bg-[rgba(0,212,170,0.1)] text-[#00d4aa] border-[rgba(0,212,170,0.15)]'
                  : 'text-[#8b8fa3] border-transparent hover:bg-[var(--sv-bg-3)] hover:text-foreground'
              }`}
            >
              <Icon className={`w-4 h-4 ${active ? 'opacity-100' : 'opacity-60'}`} />
              {item.label}
            </button>
          )
        })}
      </nav>

      {/* User */}
      <div className="border-t border-[var(--sv-bg-3)] p-3">
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
        <LogIn className="w-3.5 h-3.5" /> Google 登入
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-2.5">
      <div className="w-[30px] h-[30px] rounded-full flex items-center justify-center font-bold text-[11px]"
           style={{ background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' }}>
        {user?.name?.[0] ?? 'U'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold truncate">{user?.name}</p>
        <p className="text-[10px] text-muted-foreground truncate">{user?.role ?? 'user'}</p>
      </div>
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={logout}>
        <LogOut className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

// ── Main AppShell ────────────────────────────────────────────────────────────
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
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--sv-bg-0)' }}>

      {/* ── Desktop Sidebar ── */}
      <aside
        className="hidden lg:flex flex-col shrink-0 relative z-10"
        style={{ width: 220, background: 'var(--sv-bg-1)', borderRight: '1px solid rgba(255,255,255,0.05)' }}
      >
        <SidebarNav currentPath={location} onNavigate={handleNavigate} />
      </aside>

      {/* ── Mobile Sheet ── */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[220px] p-0" style={{ background: 'var(--sv-bg-1)' }}>
          <SidebarNav currentPath={location} onNavigate={handleNavigate} />
        </SheetContent>
      </Sheet>

      {/* ── Main Area ── */}
      <div className="flex-1 flex flex-col overflow-hidden relative z-10">

        {/* Topbar */}
        <div
          className="flex items-center gap-4 px-5 shrink-0"
          style={{ height: 42, background: 'var(--sv-bg-1)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
        >
          {/* Mobile hamburger */}
          <Button size="icon" variant="ghost" className="lg:hidden h-8 w-8 -ml-1" onClick={() => setSidebarOpen(true)}>
            <Menu className="w-4 h-4" />
          </Button>

          {/* Market ticker */}
          <div className="hidden sm:flex items-center gap-5">
            <MarketTicker />
          </div>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2.5">
            {/* Search */}
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11.5px] text-muted-foreground cursor-pointer hover:border-[var(--sv-bg-4)]"
                 style={{ background: 'var(--sv-bg-2)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 180 }}>
              <Search className="w-3.5 h-3.5" />
              搜尋股票
              <kbd className="ml-auto text-[9px] font-mono px-1 rounded border border-[rgba(255,255,255,0.1)]" style={{ background: 'var(--sv-bg-4)' }}>⌘K</kbd>
            </div>

            {/* Notifications */}
            {isAuthenticated && unreadCount > 0 && (
              <div className="relative w-[30px] h-[30px] flex items-center justify-center rounded-lg hover:bg-[var(--sv-bg-3)] cursor-pointer">
                <Bell className="w-[15px] h-[15px] text-[#8b8fa3]" />
                <span className="absolute top-1 right-1 w-[5px] h-[5px] bg-red-500 rounded-full" />
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <main className="flex-1 overflow-y-auto" style={{ background: 'var(--sv-bg-0)' }}>
          {children}
        </main>
      </div>
    </div>
  )
}
