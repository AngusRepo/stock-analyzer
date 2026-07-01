import { useState, type ReactNode } from 'react'
import { useLocation } from 'wouter'
import {
  Activity,
  Bot,
  Boxes,
  ChevronRight,
  FlaskConical,
  GitBranch,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  type LucideIcon,
} from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { isPrimaryAdminUser } from '@/lib/adminAccess'
import { useAuth } from '@/_core/hooks/useAuth'

type NavItem = {
  label: string
  icon: LucideIcon
  href: string
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: '首頁', icon: LayoutDashboard, href: '/' },
  { label: '模擬交易室', icon: Bot, href: '/bot', adminOnly: true },
  { label: '策略實驗室', icon: FlaskConical, href: '/strategy-lab', adminOnly: true },
  { label: 'OBS', icon: Activity, href: '/obs', adminOnly: true },
  { label: '流程追蹤', icon: GitBranch, href: '/pipeline', adminOnly: true },
  { label: '模型池', icon: Boxes, href: '/model-pool', adminOnly: true },
]

function isActivePath(itemHref: string, currentPath: string) {
  if (itemHref === '/') return currentPath === '/' || currentPath === '/dashboard' || currentPath === '/home' || currentPath.startsWith('/stock/')
  return currentPath === itemHref || currentPath.startsWith(`${itemHref}/`)
}

function visibleNavItems(isAdmin: boolean) {
  return NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin)
}

function BrandButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex min-w-0 items-center gap-2.5 pr-2">
      <span className="relative grid h-8 w-8 place-items-center rounded-[10px]">
        <span className="absolute inset-1 rounded-[8px] bg-blue-500/20 blur-[6px]" />
        <span className="relative h-3.5 w-3.5 rounded-[4px] border-2 border-blue-300 bg-[#090a0d] shadow-[inset_4px_0_0_rgba(255,255,255,0.86)]" />
      </span>
      <span className="hidden font-['Outfit'] text-lg font-semibold text-slate-100 sm:inline">
        Stock<span className="text-blue-400">Vision</span>
      </span>
    </button>
  )
}

function MobileNav({
  currentPath,
  onNavigate,
}: {
  currentPath: string
  onNavigate: (href: string) => void
}) {
  const { user } = useAuth()
  const items = visibleNavItems(isPrimaryAdminUser(user))

  return (
    <nav className="flex h-full flex-col bg-[#0d0e13] text-slate-100">
      <div className="border-b border-white/[0.08] px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-[12px] border border-blue-400/30 bg-blue-500/10">
            <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-blue-300 bg-[#090a0d] shadow-[inset_4px_0_0_rgba(255,255,255,0.85)]" />
          </div>
          <div>
            <p className="font-['Outfit'] text-sm font-bold">StockVision</p>
            <p className="text-[11px] text-slate-500">market intelligence</p>
          </div>
        </div>
      </div>
      <div className="space-y-1 p-3">
        {items.map((item) => {
          const Icon = item.icon
          const active = isActivePath(item.href, currentPath)
          return (
            <button
              key={item.href}
              type="button"
              onClick={() => onNavigate(item.href)}
              className={`grid w-full grid-cols-[22px_1fr_14px] items-center gap-2 rounded-[16px] border px-3 py-3 text-left text-sm font-semibold transition ${
                active
                  ? 'border-blue-400/35 bg-blue-500/12 text-white shadow-[inset_3px_0_0_#2f6bff]'
                  : 'border-transparent text-slate-400 hover:border-white/[0.08] hover:bg-white/[0.055] hover:text-slate-100'
              }`}
            >
              <Icon className={`h-4 w-4 ${active ? 'text-blue-300' : 'text-slate-500'}`} />
              <span>{item.label}</span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function AuthButton() {
  const { user, isAuthenticated, login, logout } = useAuth()

  return (
    <button
      type="button"
      onClick={isAuthenticated ? logout : login}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.075] px-3 text-xs font-semibold text-slate-300 transition hover:border-blue-400/35 hover:bg-blue-500/10 hover:text-white"
      title={isAuthenticated ? '登出' : '登入'}
    >
      {isAuthenticated && user?.avatar ? (
        <img src={user.avatar} alt={user?.name ?? 'user'} className="h-5 w-5 rounded-full" />
      ) : isAuthenticated ? (
        <LogOut className="h-4 w-4" />
      ) : (
        <LogIn className="h-4 w-4" />
      )}
      <span>{isAuthenticated ? '登出' : '登入'}</span>
    </button>
  )
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user } = useAuth()
  const items = visibleNavItems(isPrimaryAdminUser(user))

  const navigate = (href: string) => {
    setLocation(href)
    setMobileOpen(false)
  }

  return (
    <div className="sv-safe-shell min-h-screen overflow-x-hidden bg-[#090a0d] text-slate-100">
      <header className="sv-app-header fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#111218]/95 shadow-[0_10px_32px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="sv-app-header-inner flex w-full max-w-none items-center gap-4 px-4 md:px-8 2xl:px-10">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.08] bg-white/[0.06] text-slate-300 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="開啟導覽"
          >
            <Menu className="h-4 w-4" />
          </button>

          <BrandButton onClick={() => navigate('/')} />

          <nav className="mx-auto hidden items-center gap-6 lg:flex">
            {items.map((item) => {
              const active = isActivePath(item.href, location)
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigate(item.href)}
                  className={`relative px-1 py-4 text-[14px] font-semibold transition-colors ${
                    active ? 'text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {item.label}
                  {active && <span className="absolute inset-x-0 bottom-2 h-0.5 rounded-full bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.88)]" />}
                </button>
              )
            })}
          </nav>

          <div className="ml-auto">
            <AuthButton />
          </div>
        </div>
      </header>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[min(86vw,280px)] border-white/[0.08] p-0">
          <MobileNav currentPath={location} onNavigate={navigate} />
        </SheetContent>
      </Sheet>

      <main className="sv-app-main sv-stockintelli-page min-h-screen">{children}</main>
    </div>
  )
}
