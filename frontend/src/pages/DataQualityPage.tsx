import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { dataQualityApi, deployGateApi, type DataQualityReport, type DeployGateReport, type DataQualityCheck } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'

function badgeClass(status?: string) {
  if (status === 'ok' || status === 'PASS') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
  if (status === 'warn' || status === 'WARN') return 'bg-amber-500/15 text-amber-300 border-amber-500/20'
  if (status === 'fail' || status === 'BLOCK') return 'bg-red-500/15 text-red-300 border-red-500/20'
  return 'bg-zinc-700/40 text-zinc-300 border-zinc-600/40'
}

function metricSummary(check: DataQualityCheck): string {
  if (!check.metrics) return '無額外指標'
  return Object.entries(check.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(4)) : String(value)}`)
    .join(' · ')
}

function CheckCard({ check }: { check: DataQualityCheck }) {
  return (
    <Card className={check.status === 'fail' ? 'border-red-500/30' : check.status === 'warn' ? 'border-amber-500/25' : ''}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Badge variant="outline" className={`mt-0.5 shrink-0 ${badgeClass(check.status)}`}>{check.status}</Badge>
          <div className="min-w-0">
            <div className="font-semibold text-sm">{check.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">{check.summary}</div>
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

  const gaps = useMemo(() => {
    return (quality?.checks ?? []).filter((check) => check.status !== 'ok')
  }, [quality])

  const okCount = quality?.checks.filter((check) => check.status === 'ok').length ?? 0
  const warnCount = quality?.checks.filter((check) => check.status === 'warn').length ?? 0
  const failCount = quality?.checks.filter((check) => check.status === 'fail').length ?? 0

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 載入資料品質狀態...
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
              <Database className="h-5 w-5 text-sky-400" /> Data Quality Monitor
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              P6 資料清洗與 P9 deploy gate 的同一份觀測面，避免 screener、feature、ML enrichment 新舊 owner 各看各的。
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setRefreshing(true); load() }}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> 重新整理
          </Button>
        </div>

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="p-4 text-sm text-red-300">Data Quality API 載入失敗：{error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Overall</div>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="outline" className={badgeClass(quality?.overall)}>{quality?.overall ?? 'unknown'}</Badge>
                <span className="text-xs text-muted-foreground">{quality?.date ?? '-'}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Checks</div>
              <div className="mt-2 text-lg font-bold">{quality?.checks.length ?? 0}</div>
              <div className="text-xs text-muted-foreground">ok {okCount} · warn {warnCount} · fail {failCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Deploy Gate</div>
              <div className="mt-2 flex items-center gap-2">
                <Badge variant="outline" className={badgeClass(gate?.decision)}>{gate?.decision ?? 'unknown'}</Badge>
                <ShieldCheck className="h-4 w-4 text-sky-400" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">缺口</div>
              <div className={`mt-2 text-lg font-bold ${gaps.length ? 'text-amber-300' : 'text-emerald-300'}`}>{gaps.length}</div>
              <div className="text-xs text-muted-foreground">{gaps.length ? '需要追查或觀察' : '目前無明顯缺口'}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> 缺口優先處理
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {gaps.length > 0 ? (
              gaps.map((check) => <CheckCard key={check.id} check={check} />)
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> 目前資料品質 gate 沒有 fail/warn 缺口。
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">全部檢查項目</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {(quality?.checks ?? []).map((check) => <CheckCard key={check.id} check={check} />)}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
