import { useEffect, useState } from 'react'
import { marketApi } from '@/lib/api'

interface MarketRisk {
  date: string
  vix: number | null
  vixLevel: string
  twiiClose: number | null
  twiiVol20: number | null
  twiiMa20: number | null
  twiiBias: number | null
  foreignConsecutiveSell: number
  foreignNet5d: number | null
  marginRatio: number | null
  riskScore: number
  riskLevel: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  riskSummary: string
  calculatedAt: string
}

interface HistoryRow {
  date: string
  risk_score: number
  risk_level: string
  vix: number | null
  twii_close: number | null
}

const LEVEL_CONFIG = {
  green:  { label: '低風險',   color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', bar: 'bg-emerald-500', emoji: '🟢' },
  yellow: { label: '輕度警戒', color: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/30',  bar: 'bg-yellow-500',  emoji: '🟡' },
  orange: { label: '中度警戒', color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  bar: 'bg-orange-500',  emoji: '🟠' },
  red:    { label: '高度警戒', color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     bar: 'bg-red-500',     emoji: '🔴' },
  black:  { label: '極端風險', color: 'text-zinc-300',    bg: 'bg-zinc-800/80',    border: 'border-zinc-500/50',    bar: 'bg-zinc-400',    emoji: '⚫' },
}

const VIX_LABEL: Record<string, string> = {
  low: '極度平靜', normal: '正常', elevated: '偏高', high: '恐慌', extreme: '極度恐慌'
}

export default function MarketRiskPanel() {
  const [risk, setRisk] = useState<MarketRisk | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [riskData, histData] = await Promise.all([
          marketApi.risk(),
          marketApi.riskHistory(30),
        ])
        setRisk(riskData)
        setHistory(histData)
      } catch (e: any) {
        setError(e.message ?? 'load_failed')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
      <div className="flex gap-2 items-center">
        <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        載入大盤風險中...
      </div>
    </div>
  )

  if (error) return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.35)]" />
        <div>
          <p className="font-semibold text-amber-200">市場風險暫時無法載入</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            風控 API 回應異常，首頁先以保守狀態顯示；不會影響 AI 推薦或交易邏輯。
          </p>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
            source=market/risk · status=degraded
          </p>
        </div>
      </div>
    </div>
  )

  if (!risk) return null

  const cfg = LEVEL_CONFIG[risk.riskLevel] ?? LEVEL_CONFIG.green
  const scoreWidth = `${risk.riskScore}%`

  return (
    <div className="space-y-4">

      {/* 主風險卡 */}
      <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-5`}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">大盤風險等級</div>
            <div className={`text-2xl font-bold ${cfg.color} flex items-center gap-2`}>
              <span>{cfg.emoji}</span>
              <span>{cfg.label}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground mb-1">風險評分</div>
            <div className={`text-3xl font-bold tabular-nums ${cfg.color}`}>
              {risk.riskScore}
              <span className="text-sm font-normal text-muted-foreground">/100</span>
            </div>
          </div>
        </div>

        {/* 評分條 */}
        <div className="h-2 bg-muted/30 rounded-full overflow-hidden mb-4">
          <div
            className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`}
            style={{ width: scoreWidth }}
          />
        </div>

        {/* AI 摘要 */}
        <p className="text-sm text-foreground/80 leading-relaxed">{risk.riskSummary}</p>

        <div className="text-xs text-muted-foreground mt-3">
          更新時間：{new Date(risk.calculatedAt).toLocaleString('zh-TW')}
        </div>
      </div>

      {/* 指標明細 */}
      <div className="grid grid-cols-2 gap-3">

        {/* VIX */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">VIX 恐慌指數</div>
          <div className="text-xl font-bold tabular-nums">
            {risk.vix?.toFixed(1) ?? '—'}
          </div>
          <div className="text-xs mt-1">
            <span className={
              risk.vixLevel === 'extreme' ? 'text-red-400' :
              risk.vixLevel === 'high' ? 'text-orange-400' :
              risk.vixLevel === 'elevated' ? 'text-yellow-400' :
              'text-emerald-400'
            }>
              {VIX_LABEL[risk.vixLevel] ?? risk.vixLevel}
            </span>
            <span className="text-muted-foreground ml-1">（正常 &lt;20）</span>
          </div>
        </div>

        {/* 台股波動率 */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">台股20日波動率</div>
          <div className="text-xl font-bold tabular-nums">
            {risk.twiiVol20 != null ? `${risk.twiiVol20}%` : '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            年化｜正常 &lt;18%
          </div>
        </div>

        {/* 大盤乖離率 */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">大盤乖離率（20MA）</div>
          <div className={`text-xl font-bold tabular-nums ${
            risk.twiiBias == null ? '' :
            Math.abs(risk.twiiBias) >= 6 ? 'text-orange-400' :
            Math.abs(risk.twiiBias) >= 3 ? 'text-yellow-400' : 'text-emerald-400'
          }`}>
            {risk.twiiBias != null
              ? `${risk.twiiBias > 0 ? '+' : ''}${risk.twiiBias.toFixed(1)}%`
              : '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            MA20：{risk.twiiMa20?.toLocaleString('zh-TW') ?? '—'}
          </div>
        </div>

        {/* 外資動向 */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-1">外資動向</div>
          <div className={`text-xl font-bold tabular-nums ${
            risk.foreignConsecutiveSell <= -3 ? 'text-red-400' :
            risk.foreignConsecutiveSell <= -1 ? 'text-orange-400' :
            'text-emerald-400'
          }`}>
            {risk.foreignConsecutiveSell < 0
              ? `連賣 ${Math.abs(risk.foreignConsecutiveSell)} 日`
              : risk.foreignConsecutiveSell > 0
              ? `連買 ${risk.foreignConsecutiveSell} 日`
              : '中性'}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            近5日：{risk.foreignNet5d != null
              ? `${risk.foreignNet5d > 0 ? '+' : ''}${risk.foreignNet5d.toFixed(0)} 億`
              : '—'}
          </div>
        </div>

      </div>

      {/* 30 日風險趨勢（簡易橫條圖）*/}
      {history.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            近30日風險趨勢
          </div>
          <div className="flex items-end gap-0.5 h-16">
            {history.slice(-30).map((row) => {
              const h = Math.max(4, (row.risk_score / 100) * 64)
              const barCfg = LEVEL_CONFIG[row.risk_level as keyof typeof LEVEL_CONFIG] ?? LEVEL_CONFIG.green
              return (
                <div
                  key={row.date}
                  className="flex-1 rounded-sm transition-all"
                  style={{ height: `${h}px` }}
                  title={`${row.date} 風險:${row.risk_score}`}
                >
                  <div className={`w-full h-full rounded-sm ${barCfg.bar} opacity-80`} />
                </div>
              )
            })}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>{history[0]?.date.slice(5)}</span>
            <span>今日</span>
          </div>
        </div>
      )}

      {/* 融資使用率 */}
      {risk.marginRatio != null && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs text-muted-foreground mb-2">融資使用率</div>
          <div className="flex items-center gap-3">
            <div className={`text-xl font-bold tabular-nums ${
              risk.marginRatio >= 80 ? 'text-red-400' :
              risk.marginRatio >= 65 ? 'text-yellow-400' : 'text-emerald-400'
            }`}>
              {risk.marginRatio.toFixed(1)}%
            </div>
            <div className="flex-1 h-2 bg-muted/30 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  risk.marginRatio >= 80 ? 'bg-red-500' :
                  risk.marginRatio >= 65 ? 'bg-yellow-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, risk.marginRatio)}%` }}
              />
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-1">警戒線 80%</div>
        </div>
      )}

    </div>
  )
}
