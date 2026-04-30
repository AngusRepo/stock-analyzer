import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Command,
  Database,
  GitBranch,
  Layers3,
  LineChart,
  LockKeyhole,
  Network,
  RadioTower,
  Search,
  ShieldCheck,
  TimerReset,
  Workflow,
  XCircle,
} from 'lucide-react'

type View = 'dashboard' | 'bot' | 'obs'
type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'
type CatMood = 'bull' | 'paper' | 'goblin'

const toneClass: Record<Tone, string> = {
  ok: 'text-[#44f2a1] border-[#44f2a1]/35 bg-[#44f2a1]/8',
  warn: 'text-[#ffbf5f] border-[#ffbf5f]/35 bg-[#ffbf5f]/10',
  error: 'text-[#ff6b8a] border-[#ff6b8a]/35 bg-[#ff6b8a]/10',
  info: 'text-[#4cc9ff] border-[#4cc9ff]/35 bg-[#4cc9ff]/8',
  neutral: 'text-slate-300 border-white/12 bg-white/[0.035]',
}

const navItems: Array<{ id: View; label: string; kicker: string; icon: typeof LineChart }> = [
  { id: 'dashboard', label: 'Dashboard', kicker: 'Market decision desk', icon: LineChart },
  { id: 'bot', label: 'Bot', kicker: 'Execution and queue desk', icon: Bot },
  { id: 'obs', label: 'OBS', kicker: 'Reliability command center', icon: Activity },
]

const tape = [
  ['TWII', '+0.82%', 'ok'],
  ['OTC', '+0.35%', 'ok'],
  ['USD/TWD', '32.41', 'neutral'],
  ['Liquidity', 'Thin', 'warn'],
  ['Regime', 'Bull 0.71', 'ok'],
  ['DQ', '92', 'ok'],
  ['IC', 'Warming', 'warn'],
  ['P9 Gate', 'Armed', 'info'],
] as const

const functionKeys = [
  ['F1', 'MARKET'],
  ['F2', 'NEWS'],
  ['F3', 'SCREENER'],
  ['F4', 'WATCH'],
  ['F5', 'AI'],
  ['F6', 'VOL'],
  ['F7', 'PORT'],
  ['F8', 'OBS'],
] as const

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

function Status({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]', toneClass[tone])}>
      <CircleDot className="h-2.5 w-2.5" />
      {children}
    </span>
  )
}

function CatSticker({ mood, className }: { mood: CatMood; className?: string }) {
  const config = {
    bull: {
      color: '#ffbf5f',
      accent: '#44f2a1',
      mouth: 'M118 88 Q132 100 146 88',
      eyes: (
        <>
          <path d="M97 64 L114 58 L109 73 Z" fill="#111827" />
          <path d="M151 58 L168 64 L155 73 Z" fill="#111827" />
        </>
      ),
      prop: (
        <>
          <rect x="204" y="56" width="22" height="78" rx="4" fill="#44f2a1" stroke="#111827" strokeWidth="5" />
          <line x1="215" y1="36" x2="215" y2="154" stroke="#111827" strokeWidth="5" strokeLinecap="round" />
          <path d="M224 39 L244 52 L232 69 L213 58 Z" fill="#ffbf5f" stroke="#111827" strokeWidth="4" />
        </>
      ),
    },
    paper: {
      color: '#4cc9ff',
      accent: '#ffbf5f',
      mouth: 'M120 92 Q132 82 144 92',
      eyes: (
        <>
          <circle cx="104" cy="66" r="8" fill="#111827" />
          <circle cx="158" cy="66" r="8" fill="#111827" />
          <circle cx="107" cy="63" r="2.5" fill="#fff7ed" />
          <circle cx="161" cy="63" r="2.5" fill="#fff7ed" />
        </>
      ),
      prop: (
        <>
          <rect x="198" y="45" width="56" height="70" rx="8" fill="#0f172a" stroke="#111827" strokeWidth="5" />
          {[58, 72, 86, 100].map((y, index) => (
            <g key={y}>
              <line x1="207" x2="245" y1={y} y2={y} stroke={index % 2 === 0 ? '#ff6b8a' : '#44f2a1'} strokeWidth="4" strokeLinecap="round" />
              <circle cx={213 + index * 8} cy={y} r="2.5" fill="#fff7ed" />
            </g>
          ))}
          <path d="M215 132 C232 126 244 132 250 145 C230 150 217 146 215 132Z" fill="#ffbf5f" stroke="#111827" strokeWidth="4" />
        </>
      ),
    },
    goblin: {
      color: '#ff6b8a',
      accent: '#ffbf5f',
      mouth: 'M118 94 C126 87 139 87 148 94',
      eyes: (
        <>
          <path d="M96 68 Q107 58 119 67" stroke="#111827" strokeWidth="6" strokeLinecap="round" fill="none" />
          <path d="M150 67 Q162 58 174 68" stroke="#111827" strokeWidth="6" strokeLinecap="round" fill="none" />
        </>
      ),
      prop: (
        <>
          <path d="M202 64 C234 48 265 66 246 94 C233 115 207 102 209 83" fill="#0f172a" stroke="#111827" strokeWidth="5" />
          <path d="M219 74 Q228 66 237 75 M221 92 Q232 85 242 93" stroke="#ff6b8a" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M208 122 C230 120 246 130 256 148 L217 148 Z" fill="#ffbf5f" stroke="#111827" strokeWidth="5" />
        </>
      ),
    },
  }[mood]

  return (
    <div
      className={cx(
        'relative overflow-hidden bg-transparent p-1 text-[#111827]',
        'rotate-[-2deg] transition hover:rotate-1 hover:scale-[1.025]',
        className,
      )}
    >
      <svg viewBox="0 0 280 210" className="mx-auto h-44 w-full max-w-[260px] drop-shadow-[0_16px_24px_rgba(0,0,0,0.45)]" role="img" aria-label="original mischievous stock cat mascot">
        <defs>
          <radialGradient id={`catGlow-${mood}`} cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor={config.color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={config.color} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="142" cy="111" rx="122" ry="88" fill={`url(#catGlow-${mood})`} />
        <path d="M79 67 L52 21 L103 51 Z" fill="#fff7ed" stroke="#111827" strokeWidth="7" strokeLinejoin="round" />
        <path d="M181 51 L232 21 L205 67 Z" fill="#fff7ed" stroke="#111827" strokeWidth="7" strokeLinejoin="round" />
        <path d="M73 75 C73 28 202 28 211 76 C231 88 235 128 214 154 C190 184 89 184 64 154 C42 128 49 88 73 75Z" fill="#fff7ed" stroke="#111827" strokeWidth="7" />
        <path d="M73 76 C93 52 190 51 210 76" stroke={config.color} strokeWidth="7" strokeLinecap="round" fill="none" />
        {config.eyes}
        <path d="M130 80 L140 80 L135 90 Z" fill={config.accent} stroke="#111827" strokeWidth="4" strokeLinejoin="round" />
        <path d={config.mouth} stroke="#111827" strokeWidth="5" strokeLinecap="round" fill="none" />
        <path d="M72 105 L35 96 M74 117 L34 121 M201 105 L241 96 M200 117 L240 121" stroke="#111827" strokeWidth="4" strokeLinecap="round" />
        <path d="M86 154 C74 183 51 184 45 168 C57 163 67 151 74 137" fill="#fff7ed" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        <path d="M191 154 C205 184 230 184 234 168 C221 164 211 151 203 137" fill="#fff7ed" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        <path d="M111 162 C104 194 83 198 76 180 C91 176 96 160 101 146" fill="#fff7ed" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        <path d="M162 162 C170 194 191 198 199 180 C182 176 177 160 172 146" fill="#fff7ed" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        <path d="M218 136 C257 137 270 103 243 88 C236 104 224 113 207 111" fill="none" stroke="#fff7ed" strokeWidth="15" strokeLinecap="round" />
        <path d="M218 136 C257 137 270 103 243 88 C236 104 224 113 207 111" fill="none" stroke="#111827" strokeWidth="6" strokeLinecap="round" />
        <path d="M101 134 Q136 152 174 134" stroke={config.color} strokeWidth="7" strokeLinecap="round" fill="none" />
        {config.prop}
      </svg>
    </div>
  )
}

function Pane({
  title,
  kicker,
  children,
  className,
  action,
}: {
  title: string
  kicker?: string
  children: ReactNode
  className?: string
  action?: ReactNode
}) {
  return (
    <section className={cx('border border-[#2b3346] bg-[#070a10]/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_0_28px_rgba(255,180,84,0.025)]', className)}>
      <header className="flex min-h-10 items-center justify-between border-b border-[#2b3346] bg-[linear-gradient(90deg,#0d111b,#0b0c12_58%,#161006)] px-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8a92a6]">{kicker}</p>
          <h2 className="truncate text-[12px] font-semibold uppercase tracking-[0.14em] text-[#fff1cf]">{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function PriceTape() {
  return (
    <div className="grid grid-cols-2 border-b border-[#263247] bg-[#050508] font-mono text-[11px] sm:grid-cols-4 xl:grid-cols-8">
      {tape.map(([label, value, tone]) => (
        <div key={label} className="flex items-center justify-between border-r border-[#263247] px-3 py-2 last:border-r-0">
          <span className="text-[#6f7f99]">{label}</span>
          <span className={tone === 'ok' ? 'text-[#44f2a1]' : tone === 'warn' ? 'text-[#ffd166]' : tone === 'info' ? 'text-[#4cc9ff]' : 'text-slate-300'}>
            {value}
          </span>
        </div>
      ))}
    </div>
  )
}

function FunctionKeyStrip() {
  return (
    <div className="grid grid-cols-4 border-b border-[#263247] bg-[#08090f] font-mono text-[10px] md:grid-cols-8">
      {functionKeys.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="border-r border-[#263247] px-2 py-2 text-left text-[#78859b] transition hover:bg-[#1d1607] hover:text-[#ffbf5f] last:border-r-0"
          aria-label={`${key} ${label}`}
        >
          <span className="mr-2 text-[#ffd166]">{key}</span>
          {label}
        </button>
      ))}
    </div>
  )
}

function CommandBar({ view }: { view: View }) {
  const placeholder =
    view === 'dashboard'
      ? 'Type: 2330 <GO>, news semis, screen breakout, compare 5871 4938'
      : view === 'bot'
        ? 'Type: explain 4927 fill, queue ready, risk 6861, audit slippage'
        : 'Type: trace ml-predict, why bot empty, owner verify-v2, dq prices'

  return (
    <div className="grid border-b border-[#3a2c18] bg-[linear-gradient(90deg,#050508,#090909_55%,#120d06)] md:grid-cols-[1fr_auto]">
      <label className="flex min-h-11 items-center gap-2 px-3 font-mono text-[11px] text-[#70809b]">
        <Command className="h-4 w-4 text-[#4cc9ff]" />
        <span className="text-[#ffbf5f]">/</span>
        <input
          value=""
          readOnly
          aria-label="Command bar preview"
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent text-slate-200 outline-none placeholder:text-[#76624d]"
        />
      </label>
      <div className="hidden items-center border-l border-[#263247] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[#70809b] md:flex">
        ENTER EXEC
      </div>
    </div>
  )
}

function MarketMoodRibbon({ view }: { view: View }) {
  const copy =
    view === 'dashboard'
      ? ['Market mood', 'Bullish, but not drunk', 'warm hands, cold rules']
      : view === 'bot'
        ? ['Desk mood', 'Patient sniper bot', 'no quote, no candy']
        : ['Ops mood', 'Goblin detector on', 'root cause before noise']

  return (
    <div className="grid border-b border-[#3a2c18] bg-[linear-gradient(90deg,rgba(255,191,95,0.14),rgba(76,201,255,0.07),rgba(68,242,161,0.06))] font-mono text-[11px] md:grid-cols-[1.1fr_1fr_1fr_1fr]">
      <div className="border-r border-[#3a2c18] px-3 py-2">
        <span className="mr-2 text-[#8a92a6]">{copy[0]}</span>
        <span className="text-[#fff1cf]">{copy[1]}</span>
      </div>
      <div className="border-r border-[#3a2c18] px-3 py-2 text-[#ffbf5f]">{copy[2]}</div>
      <div className="border-r border-[#3a2c18] px-3 py-2 text-[#44f2a1]">human-readable rationale on</div>
      <div className="px-3 py-2 text-[#4cc9ff]">terminal density, less icebox</div>
    </div>
  )
}

function AnimatedBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <style>
        {`
          @keyframes sv-drift-a {
            0%, 100% { transform: translate3d(-4%, -2%, 0) scale(1); opacity: .72; }
            50% { transform: translate3d(7%, 5%, 0) scale(1.14); opacity: .95; }
          }
          @keyframes sv-drift-b {
            0%, 100% { transform: translate3d(5%, 3%, 0) scale(1); opacity: .52; }
            50% { transform: translate3d(-6%, -4%, 0) scale(1.2); opacity: .84; }
          }
          @keyframes sv-scan {
            0% { transform: translateY(-18%); opacity: 0; }
            12%, 70% { opacity: .34; }
            100% { transform: translateY(118vh); opacity: 0; }
          }
          @keyframes sv-orbit-soft {
            0%, 100% { transform: translate3d(0, 0, 0) rotate(-8deg) scale(1); }
            33% { transform: translate3d(34px, -22px, 0) rotate(6deg) scale(1.12); }
            66% { transform: translate3d(-26px, 28px, 0) rotate(14deg) scale(.96); }
          }
          @keyframes sv-orbit-slow {
            0%, 100% { transform: translate3d(0, 0, 0) rotate(10deg) scale(1); }
            40% { transform: translate3d(-42px, 20px, 0) rotate(-4deg) scale(1.18); }
            75% { transform: translate3d(18px, -34px, 0) rotate(-18deg) scale(.92); }
          }
          @keyframes sv-sparkle {
            0%, 100% { opacity: .22; transform: translateY(0) scale(.86); }
            50% { opacity: .92; transform: translateY(-12px) scale(1.16); }
          }
          @keyframes sv-wobble {
            0%, 100% { transform: rotate(-1deg) translateY(0); }
            50% { transform: rotate(1.5deg) translateY(-3px); }
          }
        `}
      </style>
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:18px_18px]" />
      <div className="absolute left-[-12%] top-[-18%] h-[520px] w-[520px] rounded-full bg-[#ffbf5f]/24 blur-[90px]" style={{ animation: 'sv-drift-a 9s ease-in-out infinite' }} />
      <div className="absolute right-[-8%] top-[10%] h-[460px] w-[460px] rounded-full bg-[#4cc9ff]/18 blur-[95px]" style={{ animation: 'sv-drift-b 11s ease-in-out infinite' }} />
      <div className="absolute bottom-[-18%] left-[34%] h-[560px] w-[560px] rounded-full bg-[#ff6b8a]/14 blur-[110px]" style={{ animation: 'sv-drift-a 13s ease-in-out infinite reverse' }} />
      {[
        ['12%', '24%', '#ffbf5f', '0s'],
        ['28%', '76%', '#44f2a1', '1.2s'],
        ['52%', '18%', '#4cc9ff', '0.7s'],
        ['74%', '66%', '#ff6b8a', '1.8s'],
        ['88%', '36%', '#ffbf5f', '2.4s'],
      ].map(([left, top, color, delay]) => (
        <span
          key={`${left}-${top}`}
          className="absolute h-1.5 w-1.5 rounded-full shadow-[0_0_18px_currentColor]"
          style={{ left, top, color, animation: `sv-sparkle 3.2s ease-in-out ${delay} infinite` }}
        />
      ))}
      <div
        className="absolute right-8 top-24 hidden border border-[#ffbf5f]/28 bg-[#130d06]/70 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[#ffdf9b] shadow-[0_0_30px_rgba(255,191,95,0.16)] lg:block"
        style={{ animation: 'sv-wobble 4.8s ease-in-out infinite' }}
      >
        legacy goblins not welcome
      </div>
    </div>
  )
}

function ForegroundEffects() {
  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden">
      <div
        className="absolute left-[17%] top-[11%] h-52 w-[22rem] rounded-[42%_58%_63%_37%/45%_38%_62%_55%] bg-[#ffbf5f]/20 opacity-75 mix-blend-screen blur-3xl"
        style={{ animation: 'sv-orbit-soft 9s ease-in-out infinite' }}
      />
      <div
        className="absolute right-[11%] top-[20%] h-44 w-[25rem] rotate-12 rounded-[68%_32%_48%_52%/37%_58%_42%_63%] bg-[#4cc9ff]/18 opacity-72 mix-blend-screen blur-3xl"
        style={{ animation: 'sv-orbit-slow 12s ease-in-out infinite' }}
      />
      <div
        className="absolute left-[43%] bottom-[13%] h-52 w-32 -rotate-12 rounded-[36%_64%_35%_65%/62%_34%_66%_38%] bg-[#ff6b8a]/18 opacity-70 mix-blend-screen blur-3xl"
        style={{ animation: 'sv-orbit-soft 14s ease-in-out infinite reverse' }}
      />
      <div
        className="absolute left-[61%] top-[8%] h-32 w-32 rounded-full bg-[#44f2a1]/16 opacity-70 mix-blend-screen blur-2xl"
        style={{ animation: 'sv-orbit-slow 10s ease-in-out infinite reverse' }}
      />
      <div
        className="absolute left-[29%] bottom-[28%] h-28 w-60 rotate-[-18deg] rounded-[70%_30%_55%_45%/50%_70%_30%_50%] bg-[#ffdf9b]/16 opacity-68 mix-blend-screen blur-2xl"
        style={{ animation: 'sv-orbit-soft 11s ease-in-out infinite' }}
      />
      <div
        className="absolute left-[24%] top-[39%] h-20 w-20 rounded-full border border-[#ffbf5f]/22 bg-[#ffbf5f]/12 opacity-65 mix-blend-screen blur-[14px] shadow-[0_0_42px_rgba(255,191,95,0.24)]"
        style={{ animation: 'sv-orbit-slow 7s ease-in-out infinite' }}
      />
      <div
        className="absolute right-[28%] bottom-[25%] h-20 w-44 rotate-6 rounded-[44%_56%_59%_41%/38%_60%_40%_62%] border border-[#4cc9ff]/20 bg-[#4cc9ff]/11 opacity-65 mix-blend-screen blur-[13px] shadow-[0_0_38px_rgba(76,201,255,0.22)]"
        style={{ animation: 'sv-orbit-soft 8.5s ease-in-out infinite reverse' }}
      />
      {[
        ['18%', '14%', '#ffbf5f', '0s'],
        ['34%', '32%', '#44f2a1', '.6s'],
        ['58%', '20%', '#4cc9ff', '1.1s'],
        ['79%', '42%', '#ff6b8a', '1.7s'],
        ['67%', '72%', '#ffbf5f', '2.2s'],
        ['42%', '58%', '#4cc9ff', '2.8s'],
      ].map(([left, top, color, delay]) => (
        <span
          key={`${left}-${top}-fg`}
          className="absolute h-2 w-2 rounded-full opacity-90 mix-blend-screen shadow-[0_0_20px_currentColor]"
          style={{ left, top, color, animation: `sv-sparkle 2.8s ease-in-out ${delay} infinite` }}
        />
      ))}
    </div>
  )
}

function MiniCandles() {
  const candles = [
    [18, 30, 12, 22, 'up'],
    [34, 26, 10, 18, 'down'],
    [50, 34, 16, 28, 'up'],
    [66, 46, 25, 37, 'up'],
    [82, 42, 18, 27, 'down'],
    [98, 52, 30, 44, 'up'],
    [114, 58, 34, 48, 'up'],
    [130, 50, 24, 32, 'down'],
    [146, 61, 38, 53, 'up'],
    [162, 55, 28, 39, 'down'],
    [178, 67, 44, 58, 'up'],
    [194, 73, 49, 64, 'up'],
    [210, 64, 36, 42, 'down'],
    [226, 78, 52, 70, 'up'],
    [242, 82, 60, 74, 'up'],
  ] as const

  return (
    <svg viewBox="0 0 260 110" className="h-full min-h-[220px] w-full" role="img" aria-label="mock candlestick market structure">
      <defs>
        <linearGradient id="chartGlow" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#4cc9ff" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#44f2a1" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <rect width="260" height="110" fill="url(#chartGlow)" />
      {[22, 44, 66, 88].map(y => (
        <line key={y} x1="0" x2="260" y1={y} y2={y} stroke="#273449" strokeWidth="0.7" />
      ))}
      <path d="M0 76 C38 68 58 52 84 58 C112 64 128 34 152 38 C178 42 184 22 214 28 C236 31 244 18 260 22" fill="none" stroke="#ffd166" strokeWidth="1.5" strokeDasharray="4 4" />
      <rect x="0" y="34" width="260" height="18" fill="#4cc9ff" opacity="0.08" />
      <text x="8" y="29" fill="#4cc9ff" fontSize="5" fontFamily="monospace">FAIR VALUE BAND</text>
      <text x="8" y="49" fill="#ffd166" fontSize="5" fontFamily="monospace">POC 252.5</text>
      <line x1="0" x2="260" y1="52" y2="52" stroke="#ffd166" strokeWidth="1.2" opacity="0.75" />
      {candles.map(([x, high, low, close, dir]) => {
        const up = dir === 'up'
        const bodyTop = up ? close : high - 8
        const bodyHeight = up ? high - close : close - low
        return (
          <g key={x}>
            <line x1={x} x2={x} y1={110 - high} y2={110 - low} stroke={up ? '#44f2a1' : '#ff5c7a'} strokeWidth="1.2" />
            <rect x={x - 3.5} y={110 - bodyTop} width="7" height={Math.max(5, bodyHeight)} fill={up ? '#44f2a1' : '#ff5c7a'} opacity="0.9" />
          </g>
        )
      })}
    </svg>
  )
}

function HeatMap() {
  const cells = [
    ['Semi', 82, 'ok'],
    ['AI', 77, 'ok'],
    ['Power', 66, 'info'],
    ['Biotech', 41, 'warn'],
    ['Auto', 52, 'info'],
    ['Finance', 33, 'error'],
    ['Netcom', 63, 'info'],
    ['Emerging', 58, 'warn'],
    ['Shipping', 45, 'warn'],
    ['Display', 29, 'error'],
    ['Cloud', 73, 'ok'],
    ['Retail', 39, 'error'],
  ] as const

  return (
    <div className="grid grid-cols-3 gap-px bg-[#273449] p-px font-mono text-[11px] md:grid-cols-4">
      {cells.map(([name, score, tone]) => (
        <div
          key={name}
          className={cx(
            'min-h-20 p-2',
            tone === 'ok' && 'bg-[#053d31]',
            tone === 'info' && 'bg-[#07304d]',
            tone === 'warn' && 'bg-[#43350c]',
            tone === 'error' && 'bg-[#3b111b]',
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-slate-200">{name}</span>
            <span className="text-white">{score}</span>
          </div>
          <div className="mt-6 h-1 bg-black/40">
            <div className={cx('h-full', tone === 'ok' ? 'bg-[#44f2a1]' : tone === 'info' ? 'bg-[#4cc9ff]' : tone === 'warn' ? 'bg-[#ffd166]' : 'bg-[#ff5c7a]')} style={{ width: `${score}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function NewsWire() {
  const news = [
    ['09:01:12', 'SEMIS', 'Advanced packaging wakes up and asks for coffee', 'AI'],
    ['09:06:44', 'FLOW', 'Foreign desk is quietly shopping electronic names', 'CHIP'],
    ['09:14:09', 'RISK', 'Disposition goblin caught before it entered the queue', 'GATE'],
    ['09:22:31', 'MACRO', 'TWD stable, liquidity thin: do not chase shiny candles', 'REGIME'],
    ['09:37:18', 'ALERT', 'Breakout breadth improves, volume still side-eyeing us', 'VOL'],
  ] as const

  return (
    <div className="divide-y divide-[#263247] font-mono text-[11px]">
      {news.map(([time, tag, headline, type], index) => (
        <div key={`${time}-${tag}`} className="grid grid-cols-[64px_58px_1fr_44px] gap-2 px-3 py-2 hover:bg-[#101927]">
          <span className="text-[#70809b]">{time}</span>
          <span className="text-[#ffd166]">{tag}</span>
          <span className="text-slate-200">
            {index === 0 && <span className="mr-2 animate-pulse text-[#ff5c7a]">[NEW]</span>}
            {headline}
          </span>
          <span className="text-right text-[#4cc9ff]">{type}</span>
        </div>
      ))}
    </div>
  )
}

function WatchlistRail() {
  const rows = [
    ['2330', '918.0', '+2.1%', 'ok'],
    ['5871', '126.5', '+0.8%', 'ok'],
    ['4927', '56.7', '-0.3%', 'warn'],
    ['6861', '305.0', 'BLOCK', 'error'],
    ['7584', '101.5', 'R&D', 'info'],
  ] as const

  return (
    <div className="divide-y divide-[#263247] font-mono text-[11px]">
      {rows.map(([symbol, last, change, tone]) => (
        <div key={symbol} className="grid grid-cols-[54px_1fr_58px_auto] items-center gap-2 px-3 py-2 hover:bg-[#101927]">
          <span className="text-slate-100">{symbol}</span>
          <span className="text-right text-slate-300">{last}</span>
          <span className={change.startsWith('+') ? 'text-[#44f2a1]' : change === 'BLOCK' ? 'text-[#ff5c7a]' : 'text-[#ffd166]'}>{change}</span>
          <Status tone={tone as Tone}>{tone}</Status>
        </div>
      ))}
    </div>
  )
}

function VolatilityStrip() {
  return (
    <div className="grid grid-cols-4 gap-px bg-[#263247] font-mono text-[11px]">
      {[
        ['ATR', '2.8%', 'warn'],
        ['Breadth', '61%', 'ok'],
        ['Turnover', '1.13x', 'info'],
        ['Gap risk', 'Medium', 'warn'],
      ].map(([label, value, tone]) => (
        <div key={label} className="bg-[#070a10] px-3 py-3">
          <p className="text-[#70809b]">{label}</p>
          <p className={cx('mt-1', tone === 'ok' ? 'text-[#44f2a1]' : tone === 'warn' ? 'text-[#ffd166]' : 'text-[#4cc9ff]')}>{value}</p>
        </div>
      ))}
    </div>
  )
}

function AiAgentPanel({ mode }: { mode: View }) {
  const copy =
    mode === 'obs'
      ? 'Root cause goblin says: display contract and lifecycle confidence are separate. Keep recommendations visible, label execution state honestly.'
      : mode === 'bot'
        ? 'Execution gremlin report: 6861 is blocked because tradability gate wins over score. 4927 must pass quote sanity before touching the buy button.'
        : 'Market gremlin report: bull regime is friendly, but thin liquidity is the friend who says one more drink. Sizing cap stays.'

  return (
    <div className="space-y-3 p-3 font-mono text-[11px]">
      <div className="flex items-center justify-between">
        <Status tone="info">AI analyst</Status>
        <span className="text-[#70809b]">read-only preview</span>
      </div>
      <p className="border border-[#263247] bg-[#090f19] p-3 leading-5 text-slate-200">{copy}</p>
      <div className="grid grid-cols-3 gap-px bg-[#263247]">
        {[
          ['Evidence', '4'],
          ['Unknowns', '2'],
          ['Action', '1'],
        ].map(([label, value]) => (
          <div key={label} className="bg-[#070a10] p-2">
            <p className="text-[#70809b]">{label}</p>
            <p className="mt-1 text-[#ffd166]">{value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function SignalMatrix() {
  const rows = [
    ['5871', '81', '+0.3', '2/8', 'defensive', 'T2 wait', 'ok'],
    ['4938', '80', '+0.2', '1/8', 'breakout', 'watch', 'info'],
    ['2330', '78', '+0.6', '3/8', 'trend', 'watch', 'info'],
    ['6861', 'BLOCK', '-', '-', 'restricted', 'no trade', 'error'],
    ['7584', 'R&D', '+0.1', '1/8', 'emerging', 'research', 'warn'],
  ] as const

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[720px] w-full border-collapse font-mono text-[11px]">
        <thead className="bg-[#0c1420] text-[#70809b]">
          <tr>
            {['Ticker', 'Score', 'Exp %', 'ML', 'Bucket', 'State', 'Gate'].map(label => (
              <th key={label} className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row[0]} className="hover:bg-[#101927]">
              {row.slice(0, 6).map((cell, index) => (
                <td key={`${row[0]}-${index}`} className="border border-[#263247] px-2 py-2 text-slate-200">{cell}</td>
              ))}
              <td className="border border-[#263247] px-2 py-2"><Status tone={row[6] as Tone}>{row[6]}</Status></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DashboardWorkstation() {
  return (
    <div className="grid min-h-[calc(100vh-96px)] grid-rows-[auto_1fr] border border-[#263247] bg-[#04070d]">
      <FunctionKeyStrip />
      <CommandBar view="dashboard" />
      <MarketMoodRibbon view="dashboard" />
      <PriceTape />
      <div className="grid gap-px bg-[#263247] xl:grid-cols-[300px_1fr_360px]">
        <div className="grid gap-px bg-[#263247]">
          <Pane title="Universe Radar" kicker="2,000 -> 80 -> 40" className="bg-[#050810]">
            <div className="divide-y divide-[#263247]">
              {[
                ['TWSE Main', '1,012', 'tradable lane', 'ok'],
                ['TPEX', '832', 'liquidity checked', 'ok'],
                ['Emerging', '246', 'research only', 'warn'],
                ['Disposition', '12', 'hard blocked', 'error'],
                ['Missing close', '0', 'P6 gate passed', 'ok'],
              ].map(([name, count, note, tone]) => (
                <div key={name} className="grid grid-cols-[1fr_70px] gap-2 px-3 py-3 font-mono text-[11px]">
                  <div>
                    <p className="text-slate-100">{name}</p>
                    <p className="mt-1 text-[#70809b]">{note}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-white">{count}</p>
                    <Status tone={tone as Tone}>{tone}</Status>
                  </div>
                </div>
              ))}
            </div>
          </Pane>
          <div className="bg-[#050810] p-3">
            <CatSticker mood="bull" />
          </div>
          <Pane title="Watchlist" kicker="persistent symbols">
            <WatchlistRail />
          </Pane>
        </div>

        <div className="grid grid-rows-[1fr_auto] gap-px bg-[#263247]">
          <Pane
            title="Market Structure Canvas"
            kicker="price action + risk overlay"
            action={<Status tone="ok">fresh T+0</Status>}
          >
            <div className="grid h-full grid-rows-[1fr_auto]">
              <div className="relative min-h-[300px]">
                <MiniCandles />
                <div className="absolute left-3 top-3 grid gap-2 font-mono text-[11px]">
                  <Status tone="ok">Regime bull 0.71</Status>
                  <Status tone="warn">Sizing cap 0.68x</Status>
                  <Status tone="info">Alpha breakout / vol expansion</Status>
                </div>
                <div className="absolute bottom-3 right-3 border border-[#4cc9ff]/30 bg-[#06121d]/90 p-3 font-mono text-[11px] text-[#b8c7dc]">
                  <p>POC is volume concentration inside recent lookback.</p>
                  <p>Fair value must stay near current market regime.</p>
                </div>
              </div>
              <div className="grid border-t border-[#263247] font-mono text-[11px] md:grid-cols-4">
                {[
                  ['Score model', 'percentile / z-score', 'info'],
                  ['ML vote', '8-model contract', 'ok'],
                  ['Slate', 'ranking only', 'neutral'],
                  ['Trade gate', 'T2 + debate later', 'warn'],
                ].map(([label, value, tone]) => (
                  <div key={label} className="border-r border-[#263247] px-3 py-3 last:border-r-0">
                    <p className="text-[#70809b]">{label}</p>
                    <p className={cx('mt-1', tone === 'ok' ? 'text-[#44f2a1]' : tone === 'warn' ? 'text-[#ffd166]' : tone === 'info' ? 'text-[#4cc9ff]' : 'text-slate-200')}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </Pane>
          <Pane title="Signal Matrix" kicker="not a card list">
            <SignalMatrix />
          </Pane>
        </div>

        <div className="grid gap-px bg-[#263247]">
          <Pane title="Decision Inspector" kicker="why this pick">
            <div className="space-y-4 p-3">
              <div className="border border-[#ffd166]/25 bg-[#151206] p-3">
                <div className="flex items-center justify-between font-mono">
                  <span className="text-[#ffd166]">#1 5871</span>
                  <span className="text-3xl font-semibold text-white">81</span>
                </div>
                  <p className="mt-3 text-sm leading-6 text-[#d7e2f4]">
                  Thesis panel keeps the bot from mumbling: chip flow, technical context, ML evidence, market structure, and execution state each get their own lane.
                  </p>
              </div>
              {[
                ['Chip', 'foreign flow +0.17B', 'ok'],
                ['Technical', 'RSI high, trend intact', 'warn'],
                ['ML', '2/8 bullish, 8 neutral', 'warn'],
                ['Structure', 'above value, wait pullback', 'info'],
                ['Execution', 'no pending buy until debate', 'neutral'],
              ].map(([label, detail, tone]) => (
                <div key={label} className="grid grid-cols-[82px_1fr_auto] items-center gap-2 border-b border-[#263247] pb-2 font-mono text-[11px]">
                  <span className="text-[#70809b]">{label}</span>
                  <span className="text-slate-200">{detail}</span>
                  <Status tone={tone as Tone}>{tone}</Status>
                </div>
              ))}
            </div>
          </Pane>
          <Pane title="Sector Heat" kicker="relative strength map">
            <HeatMap />
          </Pane>
          <Pane title="News Wire" kicker="market + AI tags">
            <NewsWire />
          </Pane>
          <Pane title="AI Analyst" kicker="brief, not chat spam">
            <AiAgentPanel mode="dashboard" />
          </Pane>
        </div>
      </div>
      <VolatilityStrip />
    </div>
  )
}

function QuoteLadder() {
  const asks = [
    ['305.5', '22', 'ask'],
    ['305.0', '41', 'ask'],
    ['304.5', '18', 'ask'],
  ]
  const bids = [
    ['304.0', '35', 'bid'],
    ['303.5', '27', 'bid'],
    ['303.0', '44', 'bid'],
  ]

  return (
    <div className="font-mono text-[11px]">
      {[...asks, ...bids].map(([price, size, side]) => (
        <div key={`${side}-${price}`} className={cx('grid grid-cols-[1fr_70px] border-b border-[#263247] px-3 py-2', side === 'ask' ? 'bg-[#2b1018]/50 text-[#ff8aa0]' : 'bg-[#07291f]/50 text-[#77f5ba]')}>
          <span>{price}</span>
          <span className="text-right">{size}</span>
        </div>
      ))}
    </div>
  )
}

function StateRail() {
  const states = [
    ['base ready', 'ok'],
    ['debate pending', 'info'],
    ['ready', 'neutral'],
    ['submitted', 'neutral'],
    ['filled / skipped', 'neutral'],
  ] as const

  return (
    <div className="grid gap-2 p-3">
      {states.map(([state, tone], index) => (
        <div key={state} className="grid grid-cols-[28px_1fr] items-center gap-2">
          <div className={cx('flex h-7 w-7 items-center justify-center border font-mono text-[10px]', toneClass[tone as Tone])}>{index + 1}</div>
          <div className="border border-[#263247] bg-[#090f19] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-200">{state}</div>
        </div>
      ))}
    </div>
  )
}

function BotWorkstation() {
  const blotter = [
    ['4927', 'ready', '56.70', '57.10', 'quote ok', 'ok'],
    ['6861', 'blocked', '-', '305.00', 'disposition stock', 'error'],
    ['7584', 'research', '-', '101.50', 'emerging only', 'warn'],
    ['2330', 'wait', '912.00', '918.00', 'pullback needed', 'info'],
  ] as const

  return (
    <div className="grid min-h-[calc(100vh-96px)] grid-rows-[auto_1fr] border border-[#263247] bg-[#04070d]">
      <FunctionKeyStrip />
      <CommandBar view="bot" />
      <MarketMoodRibbon view="bot" />
      <PriceTape />
      <div className="grid gap-px bg-[#263247] xl:grid-cols-[1.25fr_320px_360px]">
        <div className="grid gap-px bg-[#263247]">
          <Pane title="Execution Blotter" kicker="pending buys after debate" action={<Status tone="warn">paper only</Status>}>
            <div className="overflow-x-auto">
              <table className="min-w-[760px] w-full border-collapse font-mono text-[11px]">
                <thead className="bg-[#0c1420] text-[#70809b]">
                  <tr>
                    {['Symbol', 'State', 'Limit', 'Last', 'Guard', 'Risk'].map(label => (
                      <th key={label} className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {blotter.map(row => (
                    <tr key={row[0]} className="hover:bg-[#101927]">
                      {row.slice(0, 5).map((cell, index) => (
                        <td key={`${row[0]}-${index}`} className="border border-[#263247] px-2 py-3 text-slate-200">{cell}</td>
                      ))}
                      <td className="border border-[#263247] px-2 py-3"><Status tone={row[5] as Tone}>{row[5]}</Status></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Pane>
          <div className="grid gap-px bg-[#263247] lg:grid-cols-2">
            <Pane title="State Machine" kicker="execution lifecycle">
              <StateRail />
            </Pane>
            <Pane title="Safety Console" kicker="pre-order guardrail">
              <div className="space-y-2 p-3 font-mono text-[11px]">
                {[
                  ['Impossible fill', 'no time-travel fills at yesterday close', 'ok', CheckCircle2],
                  ['Market chasing', 'if candle runs away, let it go touch grass', 'warn', TimerReset],
                  ['Restricted board', 'disposition / emerging cannot sneak into auto buy', 'ok', LockKeyhole],
                  ['Settlement math', 'T+2 cash, market value, unrealized PnL separated', 'ok', ShieldCheck],
                ].map(([title, body, tone, Icon]) => (
                  <div key={title as string} className="grid grid-cols-[28px_1fr_auto] gap-2 border-b border-[#263247] pb-2">
                    <Icon className="h-4 w-4 text-[#4cc9ff]" />
                    <div>
                      <p className="text-slate-100">{title as string}</p>
                      <p className="mt-1 text-[#70809b]">{body as string}</p>
                    </div>
                    <Status tone={tone as Tone}>{tone as string}</Status>
                  </div>
                ))}
              </div>
            </Pane>
          </div>
        </div>

        <Pane title="Quote Ladder" kicker="five-level compatible">
          <QuoteLadder />
          <div className="border-t border-[#263247] p-3 font-mono text-[11px] text-[#70809b]">
            <p>Order engine must use live bid/ask snapshot, not stale close.</p>
            <p className="mt-2 text-[#ffd166]">If quote unavailable: fail closed, not fake a pause reason.</p>
          </div>
        </Pane>

        <Pane title="Position Risk Strip" kicker="T1 / T2 / stop">
          <div className="grid grid-cols-3 border-b border-[#263247] font-mono text-[11px]">
            {[
              ['Cash', '231k', 'neutral'],
              ['Open risk', '0.42x', 'warn'],
              ['PnL', '+677', 'ok'],
            ].map(([label, value, tone]) => (
              <div key={label} className="border-r border-[#263247] p-3 last:border-r-0">
                <p className="text-[#70809b]">{label}</p>
                <p className={cx('mt-1 text-lg', tone === 'ok' ? 'text-[#44f2a1]' : tone === 'warn' ? 'text-[#ffd166]' : 'text-slate-200')}>{value}</p>
              </div>
            ))}
          </div>
          <div className="space-y-3 p-3 font-mono text-[11px]">
            {[
              ['T1', '360.10', '+18.4%', 'ok'],
              ['T2', '420.80', '+38.2%', 'ok'],
              ['Stop', '257.10', '-15.7%', 'error'],
              ['EOD exit', 'audit required', 'pending', 'warn'],
            ].map(([label, price, delta, tone]) => (
              <div key={label} className="grid grid-cols-[46px_1fr_70px_auto] items-center gap-2 border-b border-[#263247] pb-2">
                <span className="text-[#70809b]">{label}</span>
                <span className="text-slate-100">{price}</span>
                <span className={tone === 'error' ? 'text-[#ff5c7a]' : 'text-[#44f2a1]'}>{delta}</span>
                <Status tone={tone as Tone}>{tone}</Status>
              </div>
            ))}
          </div>
          <div className="border-t border-[#263247] p-3">
            <CatSticker mood="paper" />
          </div>
          <div className="border-t border-[#263247]">
            <AiAgentPanel mode="bot" />
          </div>
        </Pane>
      </div>
    </div>
  )
}

function DependencyMatrix() {
  const columns = ['DQ', 'Pipeline', 'ML', 'Rec', 'Verify', 'UI']
  const rows = [
    ['GCP Scheduler', ['ok', 'ok', 'ok', 'ok', 'ok', 'info']],
    ['Worker API', ['ok', 'info', 'info', 'ok', 'ok', 'ok']],
    ['Cloud Run', ['ok', 'ok', 'warn', 'ok', 'ok', 'neutral']],
    ['Modal', ['neutral', 'info', 'warn', 'neutral', 'info', 'neutral']],
    ['D1/KV', ['ok', 'ok', 'ok', 'ok', 'warn', 'ok']],
  ] as const

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[680px] w-full border-collapse font-mono text-[11px]">
        <thead className="bg-[#0c1420] text-[#70809b]">
          <tr>
            <th className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">Owner</th>
            {columns.map(col => (
              <th key={col} className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([owner, states]) => (
            <tr key={owner}>
              <td className="border border-[#263247] px-2 py-2 text-slate-200">{owner}</td>
              {states.map((tone, index) => (
                <td key={`${owner}-${columns[index]}`} className="border border-[#263247] px-2 py-2">
                  <Status tone={tone as Tone}>{tone}</Status>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IncidentGraph() {
  const nodes = [
    ['Symptom', 'Bot empty but dashboard has recs', 'warn'],
    ['Owner split', 'different fallback contract', 'error'],
    ['Data quality', 'price/chip freshness check', 'ok'],
    ['Model layer', 'IC warmup / metadata gap', 'warn'],
    ['Action', 'single display contract + gate', 'info'],
  ] as const

  return (
    <div className="grid gap-2 p-3 font-mono text-[11px]">
      {nodes.map(([title, body, tone], index) => (
        <div key={title} className="grid grid-cols-[28px_1fr] gap-2">
          <div className={cx('flex h-7 w-7 items-center justify-center border', toneClass[tone as Tone])}>{index + 1}</div>
          <div className="border border-[#263247] bg-[#090f19] p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-slate-100">{title}</p>
              <Status tone={tone as Tone}>{tone}</Status>
            </div>
            <p className="mt-1 text-[#70809b]">{body}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ObsWorkstation() {
  const logs = [
    ['17:15:01', 'scheduler', 'trigger evening chain', 'ok'],
    ['17:18:44', 'data-quality', 'stock_prices latest date T+0', 'ok'],
    ['17:34:12', 'pipeline', 'feature parity accepted', 'ok'],
    ['17:47:33', 'ml-predict', 'ft metadata degraded', 'warn'],
    ['18:02:09', 'recommendation', 'display contract aligned', 'ok'],
    ['18:10:40', 'verify-v2', 'IC sample warming', 'warn'],
  ] as const

  return (
    <div className="grid min-h-[calc(100vh-96px)] grid-rows-[auto_1fr] border border-[#263247] bg-[#04070d]">
      <FunctionKeyStrip />
      <CommandBar view="obs" />
      <MarketMoodRibbon view="obs" />
      <PriceTape />
      <div className="grid gap-px bg-[#263247] xl:grid-cols-[340px_1fr_390px]">
        <Pane title="Reliability Header" kicker="SLO cockpit">
          <div className="grid grid-cols-2 gap-px bg-[#263247] font-mono text-[11px]">
            {[
              ['Freshness', 'T+0', 'ok', Database],
              ['Correctness', '88%', 'warn', ShieldCheck],
              ['Latency p95', '11m42s', 'ok', TimerReset],
              ['Error budget', '41%', 'warn', AlertTriangle],
            ].map(([label, value, tone, Icon]) => (
              <div key={label as string} className="bg-[#070a10] p-3">
                <Icon className="h-4 w-4 text-[#4cc9ff]" />
                <p className="mt-3 text-[#70809b]">{label as string}</p>
                <p className={cx('mt-1 text-2xl', tone === 'ok' ? 'text-[#44f2a1]' : 'text-[#ffd166]')}>{value as string}</p>
              </div>
            ))}
          </div>
          <IncidentGraph />
        </Pane>

        <div className="grid gap-px bg-[#263247]">
          <Pane title="Run Trace Timeline" kicker="GCP Scheduler -> Worker -> Cloud Run -> Modal -> D1" action={<Status tone="info">trace live</Status>}>
            <div className="space-y-0 p-3">
              {logs.map(([time, area, msg, tone], index) => (
                <div key={`${time}-${area}`} className="grid grid-cols-[70px_22px_130px_1fr_auto] items-center gap-2 font-mono text-[11px]">
                  <span className="text-[#70809b]">{time}</span>
                  <span className={cx('h-2.5 w-2.5 border', tone === 'ok' ? 'border-[#44f2a1] bg-[#44f2a1]' : 'border-[#ffd166] bg-[#ffd166]')} />
                  <span className="text-[#4cc9ff]">{area}</span>
                  <span className="border-b border-[#263247] py-3 text-slate-200">{msg}</span>
                  <Status tone={tone as Tone}>{tone}</Status>
                  {index < logs.length - 1 && <div className="col-start-2 h-5 w-px bg-[#263247]" />}
                </div>
              ))}
            </div>
          </Pane>
          <Pane title="Owner Dependency Matrix" kicker="where failures can cross boundaries">
            <DependencyMatrix />
          </Pane>
        </div>

        <Pane title="Operator Console" kicker="root cause not raw noise">
          <div className="space-y-3 p-3 font-mono text-[11px]">
            <CatSticker mood="goblin" />
            {[
              ['Question', 'Why is Bot empty while Dashboard has AI picks?', 'warn', Search],
              ['Evidence', 'Display owner changed fallback to pending-only too early. Classic split-brain goblin.', 'error', XCircle],
              ['Expected', 'Before morning debate, show daily recommendations with pre-trade state.', 'ok', CheckCircle2],
              ['Fix Path', 'single recommendation display contract consumed by both pages.', 'info', Workflow],
            ].map(([label, body, tone, Icon]) => (
              <div key={label as string} className="border border-[#263247] bg-[#090f19] p-3">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-[#4cc9ff]" />
                  <p className="text-slate-100">{label as string}</p>
                  <Status tone={tone as Tone}>{tone as string}</Status>
                </div>
                <p className="mt-2 leading-5 text-[#70809b]">{body as string}</p>
              </div>
            ))}
            <AiAgentPanel mode="obs" />
          </div>
        </Pane>
      </div>
    </div>
  )
}

export default function ObservabilityDemoPage() {
  const [view, setView] = useState<View>('dashboard')
  const active = useMemo(() => navItems.find(item => item.id === view) ?? navItems[0], [view])

  return (
    <main className="min-h-screen bg-[#020409] text-slate-100">
      <AnimatedBackdrop />
      <div className="relative grid min-h-screen lg:grid-cols-[230px_1fr]">
        <aside className="border-r border-[#263247] bg-[#05070c]/95">
          <div className="border-b border-[#263247] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-[#ffbf5f]/45 bg-[linear-gradient(135deg,#1e1205,#06251c)] font-mono text-sm font-black text-[#ffdf9b] shadow-[0_0_26px_rgba(255,191,95,0.16)]">
                SV
              </div>
              <div>
                <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-white">StockVision</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#70809b]">workstation demo</p>
              </div>
            </div>
          </div>

          <nav className="p-2">
            {navItems.map(item => {
              const Icon = item.icon
              const selected = item.id === view
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setView(item.id)}
                  className={cx(
                    'group mb-1 grid w-full grid-cols-[32px_1fr_16px] items-center gap-2 border px-2 py-3 text-left font-mono transition',
                    selected ? 'border-[#ffbf5f]/45 bg-[linear-gradient(90deg,#1a1207,#06121d)] text-white shadow-[inset_3px_0_0_#ffbf5f]' : 'border-transparent text-[#78859b] hover:border-[#3a2c18] hover:bg-[#120d06] hover:text-[#fff1cf]',
                  )}
                >
                  <Icon className={cx('h-4 w-4', selected ? 'text-[#ffbf5f]' : 'text-[#78859b]')} />
                  <span>
                    <span className="block text-[12px] uppercase tracking-[0.14em]">{item.label}</span>
                    <span className="mt-0.5 block text-[10px] normal-case tracking-normal text-[#70809b]">{item.kicker}</span>
                  </span>
                  <ChevronRight className={cx('h-3.5 w-3.5 transition', selected ? 'text-[#ffbf5f]' : 'text-[#445068] group-hover:text-[#fff1cf]')} />
                </button>
              )
            })}
          </nav>

          <div className="mt-4 border-y border-[#3a2c18] bg-[#0b0907] p-3 font-mono text-[10px] uppercase tracking-[0.13em] text-[#8a92a6]">
            <div className="mb-2 flex items-center gap-2 text-[#ffbf5f]">
              <Command className="h-3.5 w-3.5" />
              Design mode
            </div>
            <p>No API mutation</p>
            <p>No backend rewrite</p>
            <p>Three separate pages</p>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="grid gap-px border-b border-[#263247] bg-[#263247] lg:grid-cols-[1fr_360px]">
            <div className="bg-[linear-gradient(90deg,#07080d,#111008)] px-4 py-3">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#70809b]">
                <RadioTower className="h-3.5 w-3.5 text-[#ffbf5f]" />
                {active.kicker}
              </div>
              <h1 className="mt-1 text-xl font-semibold uppercase tracking-[0.04em] text-[#fff1cf]">
                {view === 'dashboard' && 'Decision Workstation'}
                {view === 'bot' && 'Execution Blotter'}
                {view === 'obs' && 'Reliability Mission Control'}
              </h1>
            </div>
            <div className="grid grid-cols-3 bg-[#05070c] font-mono text-[11px]">
              {[
                ['Mode', 'Preview', 'info'],
                ['Surface', view.toUpperCase(), 'neutral'],
                ['Mutation', 'None', 'ok'],
              ].map(([label, value, tone]) => (
                <div key={label} className="border-l border-[#263247] px-3 py-3">
                  <p className="text-[#70809b]">{label}</p>
                  <p className={cx('mt-1', tone === 'ok' ? 'text-[#44f2a1]' : tone === 'info' ? 'text-[#4cc9ff]' : 'text-slate-200')}>{value}</p>
                </div>
              ))}
            </div>
          </header>

          {view === 'dashboard' && <DashboardWorkstation />}
          {view === 'bot' && <BotWorkstation />}
          {view === 'obs' && <ObsWorkstation />}

          <footer className="grid gap-px border-t border-[#263247] bg-[#263247] font-mono text-[11px] lg:grid-cols-4">
            {[
              ['Bloomberg cue', 'dense panes, not marketing cards', Layers3],
              ['TradingView cue', 'watchlist + chart + alert workspace', LineChart],
              ['Linear cue', 'owner state and recovery path', GitBranch],
              ['Vercel cue', 'SLO, traces, and event correlation', Network],
            ].map(([title, body, Icon]) => (
              <div key={title as string} className="bg-[#05070c] p-3">
                <Icon className="h-4 w-4 text-[#4cc9ff]" />
                <p className="mt-2 uppercase tracking-[0.14em] text-slate-200">{title as string}</p>
                <p className="mt-1 text-[#70809b]">{body as string}</p>
              </div>
            ))}
          </footer>
        </section>
      </div>
      <ForegroundEffects />
    </main>
  )
}
