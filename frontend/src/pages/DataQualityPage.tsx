import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import { dataQualityApi, type DataQualityCheck } from '@/lib/api'
import { queryTtl } from '@/lib/queryPolicy'
import { AlertTriangle, CheckCircle2, Database, RefreshCw } from 'lucide-react'
import { DecisionTraceRail, SignalInsightCard } from '@/components/workstation/DecisionArchitecture'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'

function statusTone(status?: string): WorkstationTone {
  if (status === 'ok' || status === 'PASS') return 'ok'
  if (status === 'warn' || status === 'WARN') return 'warn'
  if (status === 'fail' || status === 'BLOCK') return 'error'
  return 'neutral'
}

function metricSummary(check: DataQualityCheck): string {
  if (!check.metrics) return 'no metrics'
  return Object.entries(check.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(4)) : String(value)}`)
    .join(' / ')
}

function CheckCard({ check }: { check: DataQualityCheck }) {
  return (
    <div className={`rounded-2xl border bg-[#171714] p-3 ${check.status === 'fail' ? 'border-rose-400/35' : check.status === 'warn' ? 'border-[#d6a85f]/35' : 'border-[#3a3125]'}`}>
      <div className="flex items-start gap-3">
        <WorkstationPill tone={statusTone(check.status)}>{check.status}</WorkstationPill>
        <div className="min-w-0">
          <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#fff7e8]">{check.label}</div>
          <div className="mt-1 text-xs leading-5 text-[#b9b1a1]">{check.summary}</div>
          <div className="mt-2 font-mono text-[10px] text-[#8f877a]">{metricSummary(check)}</div>
        </div>
      </div>
    </div>
  )
}

export default function DataQualityPage() {
  const quality = useQuery({
    queryKey: ['data-quality', 'drilldown'],
    queryFn: () => dataQualityApi.status(),
    staleTime: queryTtl.realtime,
  })

  const report = quality.data
  const gaps = useMemo(() => (report?.checks ?? []).filter((check) => check.status !== 'ok'), [report])
  const okCount = report?.checks.filter((check) => check.status === 'ok').length ?? 0
  const warnCount = report?.checks.filter((check) => check.status === 'warn').length ?? 0
  const failCount = report?.checks.filter((check) => check.status === 'fail').length ?? 0

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="Data care"
          title="Data Quality Drilldown / 資料品質深入追查"
          description="確認價格、籌碼、feature 與 train/serve parity 是否跟得上今天的節奏；有缺口時直接列出會影響推薦或模型判斷的項目。"
          action={
            <div className="flex flex-wrap gap-2">
              <a href="/obs" className="rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]">回系統健康</a>
              <button
                type="button"
                onClick={() => void quality.refetch()}
                className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#f1c16f]"
              >
                <RefreshCw className={`h-3 w-3 ${quality.isFetching ? 'animate-spin' : ''}`} />
                更新
              </button>
            </div>
          }
        />

        {quality.error && (
          <div className="border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            Data Quality API 載入失敗：{(quality.error as Error).message}
          </div>
        )}

        <DecisionTraceRail
          title="資料信任檢查"
          compact
          steps={[
            { label: '新鮮度', detail: '確認 price / chip / feature 日期是否新鮮且符合交易日曆。', tone: statusTone(report?.overall) },
            { label: '欄位一致', detail: '確認 screener、ML predict、recommendation 使用一致欄位。', tone: warnCount || failCount ? 'warn' : 'ok' },
            { label: '訓練服務一致', detail: '確認 train/serve parity，避免 feature 漂移只變成 warning。', tone: gaps.length ? 'warn' : 'ok' },
            { label: '影響範圍', detail: '把資料缺口轉成 affected symbols / downstream risk；release gate 請回系統健康入口。', tone: gaps.length ? 'warn' : 'ok' },
          ]}
        />

        <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <SignalInsightCard title="整體狀態" value={report?.overall ?? 'unknown'} detail={`date ${report?.date ?? '-'}`} tone={statusTone(report?.overall)} />
          <SignalInsightCard title="檢查項目" value={String(report?.checks.length ?? 0)} detail={`ok ${okCount} / warn ${warnCount} / fail ${failCount}`} tone={failCount ? 'error' : warnCount ? 'warn' : 'ok'} />
          <SignalInsightCard title="待處理缺口" value={String(gaps.length)} detail={gaps.length ? '有 fail/warn 缺口，會影響推薦、IC 或 backtest。' : '目前沒有資料品質缺口。'} tone={gaps.length ? 'warn' : 'ok'} />
          <SignalInsightCard title="責任範圍" value="Data Source" detail="freshness / schema / parity only" tone="info" />
        </section>

        <WorkstationPanel title="需要處理的資料缺口" kicker="fail and warn first">
          <div className="space-y-3 p-3">
            {gaps.length > 0 ? (
              gaps.map((check) => <CheckCard key={check.id} check={check} />)
            ) : (
              <div className="flex items-center gap-2 border border-emerald-400/20 bg-emerald-400/[0.05] p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> 目前沒有 fail/warn data quality 缺口。
              </div>
            )}
          </div>
        </WorkstationPanel>

        <WorkstationPanel title="全部品質檢查" kicker="freshness, schema, parity">
          <div className="grid grid-cols-1 gap-3 p-3 xl:grid-cols-2">
            {(report?.checks ?? []).map((check) => <CheckCard key={check.id} check={check} />)}
            {!report?.checks?.length && (
              <div className="flex items-center gap-2 border border-amber-400/20 bg-amber-400/[0.05] p-4 text-sm text-amber-200">
                <AlertTriangle className="h-4 w-4" /> 尚未取得 Data Quality checks。
              </div>
            )}
          </div>
        </WorkstationPanel>
      </div>
    </AppShell>
  )
}
