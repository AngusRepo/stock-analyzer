import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import { modelPoolApi, type ModelPoolLineageModel } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Activity, Boxes, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { DecisionTraceRail, SignalInsightCard } from '@/components/workstation/DecisionArchitecture'
import { WorkstationPanel, WorkstationPill, type WorkstationTone } from '@/components/workstation/WorkstationChrome'

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'N/A'
  if (typeof value === 'number') return value.toFixed(4)
  return String(value)
}

function toneFromStatus(status?: string): WorkstationTone {
  if (status === 'active' || status === 'ok') return 'ok'
  if (status === 'degraded' || status === 'warn') return 'warn'
  if (status === 'retired' || status === 'failed' || status === 'error') return 'error'
  return 'neutral'
}

function isStateSpaceOverlay(name: string, model: ModelPoolLineageModel) {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

function icValue(model: ModelPoolLineageModel): number | null {
  const raw = model.ic_4w_avg ?? model.rolling_ic
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function familyCounts(models: Array<[string, ModelPoolLineageModel]>) {
  return models.reduce<Record<string, number>>((acc, [, model]) => {
    const family = model.balance_family ?? model.model_type ?? 'unknown'
    if (model.status === 'active') acc[family] = (acc[family] ?? 0) + 1
    return acc
  }, {})
}

function ModelHealthRow({ name, model }: { name: string; model: ModelPoolLineageModel }) {
  const ic = icValue(model)
  const sampleCount = model.last_ic_sample_count ?? 0
  const challenger = model.challenger
  const metadataTone = model.metadata_exists === false ? 'warn' : 'ok'
  const icTone: WorkstationTone = ic == null || Math.abs(ic) < 0.0001 ? 'warn' : ic > 0 ? 'ok' : 'error'

  return (
    <tr className="hover:bg-[#101927]">
      <td className="border border-[#263247] px-2 py-2 text-slate-100">
        <div className="font-semibold">{name}</div>
        <div className="mt-0.5 text-[10px] text-[#70809b]">{model.model_type ?? 'unknown'} · {model.balance_family ?? 'unknown'}</div>
      </td>
      <td className="border border-[#263247] px-2 py-2"><WorkstationPill tone={toneFromStatus(model.status)}>{model.status ?? '-'}</WorkstationPill></td>
      <td className="border border-[#263247] px-2 py-2"><WorkstationPill tone={icTone}>{ic == null ? 'N/A' : ic.toFixed(4)}</WorkstationPill></td>
      <td className="border border-[#263247] px-2 py-2 text-slate-300">{sampleCount}</td>
      <td className="border border-[#263247] px-2 py-2"><WorkstationPill tone={metadataTone}>{model.metadata_exists === false ? 'missing' : 'present'}</WorkstationPill></td>
      <td className="border border-[#263247] px-2 py-2 text-slate-300">{challenger ? `${challenger.version ?? 'challenger'} · ${fmt(challenger.ic_4w_avg ?? challenger.rolling_ic)}` : '-'}</td>
      <td className="border border-[#263247] px-2 py-2 text-[#8a92a6]">{fmt(model.last_ic_status)}</td>
    </tr>
  )
}

function ModelDetailCard({ name, model }: { name: string; model: ModelPoolLineageModel }) {
  const activeIc = model.weekly_ic ?? []
  const challengerIc = model.challenger?.weekly_ic ?? []

  return (
    <Card className="border-zinc-800/80">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-start justify-between gap-3 text-sm">
          <div>
            <div className="font-semibold">{name}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{model.model_type ?? 'unknown'} | {model.balance_family ?? 'unknown'}</div>
          </div>
          <Badge className={`border text-[10px] ${model.status === 'active' ? 'border-emerald-500/20 bg-emerald-500/15 text-emerald-400' : 'border-amber-500/20 bg-amber-500/15 text-amber-400'}`}>
            {model.status ?? 'unknown'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-[11px]">
        <div className="grid grid-cols-2 gap-2">
          <div><div className="text-muted-foreground">Active version</div><div className="font-mono">{fmt(model.version)}</div></div>
          <div><div className="text-muted-foreground">IC 4w</div><div className="font-mono">{fmt(model.ic_4w_avg)}</div></div>
          <div><div className="text-muted-foreground">Rolling IC</div><div className="font-mono">{fmt(model.rolling_ic)}</div></div>
          <div><div className="text-muted-foreground">Neg weeks</div><div className="font-mono">{fmt(model.consecutive_negative_weeks)}</div></div>
          <div><div className="text-muted-foreground">Raw IC rows</div><div className="font-mono">{model.last_ic_sample_count ?? 0}</div></div>
          <div><div className="text-muted-foreground">Weekly windows</div><div className="font-mono">{activeIc.length}</div></div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
          <div className="mb-1 text-muted-foreground">Artifact</div>
          <div className="break-all font-mono text-[10px]">{model.gcs_path ?? 'N/A'}</div>
        </div>
        {model.challenger ? (
          <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-sky-300">Shadow challenger</span>
              <span className="font-mono text-sky-300">{model.challenger.version}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><div className="text-muted-foreground">IC 4w</div><div className="font-mono">{fmt(model.challenger.ic_4w_avg)}</div></div>
              <div><div className="text-muted-foreground">Weekly windows</div><div className="font-mono">{challengerIc.length}</div></div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-muted-foreground">No shadow challenger registered</div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ModelPoolPage() {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['model-pool', 'lineage'],
    queryFn: modelPoolApi.lineage,
    refetchInterval: 60_000,
  })

  const models = data?.models ?? {}
  const modelList = Object.entries(models).filter(([name, model]) => !isStateSpaceOverlay(name, model))
  const legacyOverlayList = Object.entries(models).filter(([name, model]) => isStateSpaceOverlay(name, model))
  const overlayList = [
    ...Object.entries(data?.state_overlays ?? {}),
    ...legacyOverlayList.map(([name, model]) => [name, {
      status: model.status,
      version: model.version,
      model_type: model.model_type,
      balance_family: model.balance_family,
      role: 'regime_risk_overlay',
      gcs_path: model.gcs_path,
      note: 'Legacy lineage entry rendered as state-space overlay; excluded from alpha model IC counts.',
    }] as const),
  ]

  const counts = familyCounts(modelList)
  const challengerCount = modelList.filter(([, model]) => !!model.challenger).length
  const missingMetadata = modelList.filter(([, model]) => !model.metadata_exists).length
  const weakIc = modelList.filter(([, model]) => {
    const ic = icValue(model)
    return ic == null || Math.abs(ic) < 0.0001
  }).length
  const sampleGaps = modelList.filter(([, model]) => Number(model.last_ic_sample_count ?? 0) <= 0).length

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Model Pool Drilldown</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              單一真相來源：model_pool.json。這頁只負責 lineage、IC、metadata、challenger 與 state-space overlay；OBS 只顯示摘要。
              {isFetching && <span className="ml-2 text-sky-400">refreshing...</span>}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading model pool...
          </div>
        )}

        {error && (
          <Card className="border-red-500/30">
            <CardContent className="pt-4 text-sm text-red-400">{(error as Error).message}</CardContent>
          </Card>
        )}

        {!isLoading && (
          <>
            <DecisionTraceRail
              title="Lifecycle Governance Contract"
              compact
              steps={[
                { label: 'Production', detail: '只由 model_pool.json 指向 active production artifact。', tone: 'ok' },
                { label: 'Challenger', detail: '新模型先 shadow predict 與累積 evidence，不直接覆蓋 production。', tone: challengerCount ? 'info' : 'warn' },
                { label: 'IC Tracker', detail: 'weekly / rolling IC 與 sample count 是 promote/degrade 的主要依據。', tone: weakIc || sampleGaps ? 'warn' : 'ok' },
                { label: 'Metadata', detail: 'artifact metadata / lineage / feature compatibility 缺失要先修。', tone: missingMetadata ? 'warn' : 'ok' },
              ]}
            />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <SignalInsightCard title="Alpha Models" value={String(modelList.length)} detail={`family ${Object.entries(counts).map(([family, count]) => `${family}:${count}`).join(' · ') || 'N/A'}`} tone="info" />
              <SignalInsightCard title="Challengers" value={String(challengerCount)} detail="Challenger 要 shadow predict 並累積 evidence，不直接 promote。" tone={challengerCount ? 'ok' : 'warn'} />
              <SignalInsightCard title="IC Gaps" value={String(weakIc)} detail={`0/NaN IC 或 sample 不足會讓投票/權重退化。sample gaps ${sampleGaps}`} tone={weakIc || sampleGaps ? 'warn' : 'ok'} />
              <SignalInsightCard title="Metadata Gaps" value={String(missingMetadata)} detail={`last updated ${data?.last_updated ?? 'N/A'}`} tone={missingMetadata ? 'warn' : 'ok'} />
            </div>

            <WorkstationPanel title="Model Health Matrix" kicker="IC, samples, metadata, challenger">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse font-mono text-[11px]">
                  <thead className="bg-[#0c1420] text-[#70809b]">
                    <tr>
                      {['Model', 'Status', 'IC 4W', 'Samples', 'Metadata', 'Challenger', 'IC status'].map((label) => (
                        <th key={label} className="border border-[#263247] px-2 py-2 text-left font-medium uppercase tracking-[0.14em]">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {modelList.map(([name, model]) => <ModelHealthRow key={name} name={name} model={model} />)}
                  </tbody>
                </table>
              </div>
            </WorkstationPanel>

            <details className="group">
              <summary className="cursor-pointer rounded-lg border border-[#263247] bg-[#070a10] px-3 py-2 text-xs font-medium text-muted-foreground hover:border-amber-300/30">
                Model artifact cards
                <span className="ml-2 text-[10px] text-muted-foreground/70">預設收合，追單一模型 artifact / challenger 時打開。</span>
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                {modelList.map(([name, model]) => <ModelDetailCard key={name} name={name} model={model} />)}
              </div>
            </details>

            <WorkstationPanel title="State-space Overlays" kicker="regime risk overlay, not alpha vote model">
              <div className="space-y-2 p-3 text-xs text-muted-foreground">
                <p>
                  Kalman / Markov 在這套系統中扮演 regime / risk overlay：提供市場狀態、波動與風控上下文，不計入 alpha model IC 投票數。
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {overlayList.map(([name, overlay]) => (
                    <div key={name} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-foreground">{name}</div>
                          <div className="mt-1 text-[11px]">{overlay.role ?? overlay.model_type ?? 'state-space overlay'}</div>
                        </div>
                        <WorkstationPill tone={toneFromStatus(overlay.status)}>{overlay.status ?? 'active'}</WorkstationPill>
                      </div>
                      <div className="mt-2 break-all font-mono text-[10px]">{overlay.gcs_path ?? 'default hyperparams'}</div>
                      {overlay.note && <div className="mt-2 text-[11px]">{overlay.note}</div>}
                    </div>
                  ))}
                  {!overlayList.length && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">No state-space overlay registered.</div>
                  )}
                </div>
              </div>
            </WorkstationPanel>

            <WorkstationPanel title="Recent Lifecycle Events" kicker="promote, degrade, restore, retire audit">
              <div className="space-y-2 p-3">
                {(data?.events ?? []).slice().reverse().slice(0, 20).map((event, index) => (
                  <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-[11px]">
                    <span className="font-mono text-sky-300">{fmt(event.model)}</span>
                    <span className="mx-2 text-muted-foreground">{fmt(event.transition)}</span>
                    <span className="text-muted-foreground">{fmt(event.at)}</span>
                    {event.reason && <div className="mt-1 text-muted-foreground">{fmt(event.reason)}</div>}
                  </div>
                ))}
                {(data?.events ?? []).length === 0 && (
                  <div className="text-sm text-muted-foreground">No lifecycle events recorded yet.</div>
                )}
              </div>
            </WorkstationPanel>
          </>
        )}
      </div>
    </AppShell>
  )
}
