import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import {
  dataQualityApi,
  deployGateApi,
  type DataQualityCheck,
  type DataQualityReport,
  type DeployGateReport,
} from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw } from 'lucide-react'
import { DecisionTraceRail, SignalInsightCard } from '@/components/workstation/DecisionArchitecture'

function badgeClass(status?: string) {
  if (status === 'ok' || status === 'PASS') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
  if (status === 'warn' || status === 'WARN') return 'bg-amber-500/15 text-amber-300 border-amber-500/20'
  if (status === 'fail' || status === 'BLOCK') return 'bg-red-500/15 text-red-300 border-red-500/20'
  return 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40'
}

function toneFromStatus(status?: string) {
  if (status === 'fail' || status === 'BLOCK') return 'error' as const
  if (status === 'warn' || status === 'WARN') return 'warn' as const
  if (status === 'ok' || status === 'PASS') return 'ok' as const
  return 'neutral' as const
}

function metricSummary(check: DataQualityCheck): string {
  if (!check.metrics) return '沒有額外 metrics'
  return Object.entries(check.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(4)) : String(value)}`)
    .join(' · ')
}

function CheckCard({ check }: { check: DataQualityCheck }) {
  return (
    <Card className={check.status === 'fail' ? 'border-red-500/30' : check.status === 'warn' ? 'border-amber-500/25' : 'border-zinc-800/80'}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Badge variant="outline" className={`mt-0.5 shrink-0 ${badgeClass(check.status)}`}>{check.status}</Badge>
          <div className="min-w-0">
            <div className="font-semibold text-sm">{check.label}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{check.summary}</div>
            <div className="mt-2 text-[11px] text-muted-foreground/70">{metricSummary(check)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function DataQualityPage() {
  const [quality, setQuality] = useState<DataQualityReport | null>(null)
  const [gate, setGate] = useState<DeployGateReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setError(null)
      const [qualityReport, gateReport] = await Promise.all([
        dataQualityApi.status(),
        deployGateApi.predeploy(),
      ])
      setQuality(qualityReport)
      setGate(gateReport)
    } catch (e: any) {
      setError(e?.message ?? 'Data quality load failed')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const gaps = useMemo(() => (quality?.checks ?? []).filter((check) => check.status !== 'ok'), [quality])
  const okCount = quality?.checks.filter((check) => check.status === 'ok').length ?? 0
  const warnCount = quality?.checks.filter((check) => check.status === 'warn').length ?? 0
  const failCount = quality?.checks.filter((check) => check.status === 'fail').length ?? 0

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 載入 Data Quality...
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <Database className="h-5 w-5 text-sky-400" /> Data Quality Drilldown
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              OBS 的資料品質深鑽頁：只看 freshness、schema、train/serve parity 與 deploy gate，不重複 Scheduler / Model Pool 摘要。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setRefreshing(true); load() }}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 更新
          </Button>
        </div>

        <DecisionTraceRail
          title="Data Trust Contract"
          compact
          steps={[
            { label: 'Freshness', detail: '先看 price / chip / feature 日期是否符合交易日曆。', tone: toneFromStatus(quality?.overall) },
            { label: 'Schema', detail: '確認 screener、ML predict、recommendation 使用一致欄位。', tone: warnCount || failCount ? 'warn' : 'ok' },
            { label: 'Parity', detail: '訓練與推論資料不可 split-brain；缺 feature 不能只當 warning。', tone: gaps.length ? 'warn' : 'ok' },
            { label: 'Gate', detail: 'Deploy / pipeline 前先看 gate，避免髒資料一路寫進推薦與 IC。', tone: toneFromStatus(gate?.decision) },
          ]}
        />

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="p-4 text-sm text-red-300">Data Quality API 載入失敗：{error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <SignalInsightCard
            title="Overall"
            value={quality?.overall ?? 'unknown'}
            detail={`date ${quality?.date ?? '-'}`}
            tone={toneFromStatus(quality?.overall)}
          />
          <SignalInsightCard
            title="Checks"
            value={String(quality?.checks.length ?? 0)}
            detail={`ok ${okCount} · warn ${warnCount} · fail ${failCount}`}
            tone={failCount ? 'error' : warnCount ? 'warn' : 'ok'}
          />
          <SignalInsightCard
            title="Deploy Gate"
            value={gate?.decision ?? 'unknown'}
            detail={`checks ${gate?.checks?.length ?? 0}; this is deploy safety, not scheduler status.`}
            tone={toneFromStatus(gate?.decision)}
          />
          <SignalInsightCard
            title="Actionable Gaps"
            value={String(gaps.length)}
            detail={gaps.length ? '先處理 fail/warn，再相信推薦、IC 或 backtest。' : '目前沒有資料品質缺口。'}
            tone={gaps.length ? 'warn' : 'ok'}
          />
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> Actionable Data Gaps
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {gaps.length > 0 ? (
              gaps.map((check) => <CheckCard key={check.id} check={check} />)
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> 目前沒有 fail/warn data quality gap。
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">All Quality Checks</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {(quality?.checks ?? []).map((check) => <CheckCard key={check.id} check={check} />)}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
