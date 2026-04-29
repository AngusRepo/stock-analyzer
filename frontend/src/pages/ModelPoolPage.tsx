import { useQuery } from '@tanstack/react-query'
import AppShell from '@/components/AppShell'
import { modelPoolApi, type ModelPoolLineageModel } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Activity, Boxes, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'N/A'
  if (typeof value === 'number') return value.toFixed(4)
  return String(value)
}

function statusClass(status?: string): string {
  if (status === 'active') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
  if (status === 'degraded') return 'bg-amber-500/15 text-amber-400 border-amber-500/20'
  if (status === 'retired') return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20'
  return 'bg-sky-500/15 text-sky-400 border-sky-500/20'
}

function familyCounts(models: Record<string, ModelPoolLineageModel>) {
  return Object.values(models).reduce<Record<string, number>>((acc, model) => {
    const family = model.balance_family ?? 'unknown'
    if (model.status === 'active') acc[family] = (acc[family] ?? 0) + 1
    return acc
  }, {})
}

function ModelCard({ name, model }: { name: string; model: ModelPoolLineageModel }) {
  const activeIc = model.weekly_ic ?? []
  const challengerIc = model.challenger?.weekly_ic ?? []
  const activeRawSamples = model.last_ic_sample_count ?? 0
  const challengerRawSamples = model.challenger?.last_ic_sample_count ?? 0

  return (
    <Card className="border-zinc-800/80">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-start justify-between gap-3 text-sm">
          <div>
            <div className="font-semibold">{name}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {model.model_type ?? 'unknown'} | {model.balance_family ?? 'unknown'}
            </div>
          </div>
          <Badge className={`border text-[10px] ${statusClass(model.status)}`}>
            {model.status ?? 'unknown'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-[11px]">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-muted-foreground">Active version</div>
            <div className="font-mono">{fmt(model.version)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">IC 4w</div>
            <div className="font-mono">{fmt(model.ic_4w_avg)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Neg weeks</div>
            <div className="font-mono">{fmt(model.consecutive_negative_weeks)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Metadata</div>
            <div className={model.metadata_exists ? 'text-emerald-400' : 'text-amber-400'}>
              {model.metadata_exists ? 'present' : 'missing'}
            </div>
          </div>
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
              <div>
                <div className="text-muted-foreground">IC 4w</div>
                <div className="font-mono">{fmt(model.challenger.ic_4w_avg)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Weekly windows</div>
                <div className="font-mono">{challengerIc.length}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Raw IC rows</div>
                <div className="font-mono">{challengerRawSamples}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Last status</div>
                <div className="font-mono">{fmt(model.challenger.last_ic_status)}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-muted-foreground">
            No shadow challenger registered
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-muted-foreground">
          <div>
            <div>Raw IC rows</div>
            <span className="font-mono text-foreground">{activeRawSamples}</span>
          </div>
          <div>
            <div>Weekly windows</div>
            <span className="font-mono text-foreground">{activeIc.length}</span>
          </div>
          <div>
            <div>Last IC status</div>
            <span className="font-mono text-foreground">{fmt(model.last_ic_status)}</span>
          </div>
        </div>
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
  const modelList = Object.entries(models)
  const counts = familyCounts(models)
  const challengerCount = modelList.filter(([, model]) => !!model.challenger).length
  const missingMetadata = modelList.filter(([, model]) => !model.metadata_exists).length

  return (
    <AppShell>
      <div className="space-y-6 p-4 lg:p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Model Pool Lifecycle</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Single source: model_pool.json | Last updated: {data?.last_updated ?? 'N/A'}
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

        {!isLoading && !error && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card><CardContent className="px-4 pb-3 pt-4">
                <Boxes className="mb-2 h-4 w-4 text-sky-400" />
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Models</p>
                <p className="mt-1 text-2xl font-bold">{modelList.length}</p>
              </CardContent></Card>
              <Card><CardContent className="px-4 pb-3 pt-4">
                <GitBranch className="mb-2 h-4 w-4 text-sky-400" />
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Challengers</p>
                <p className="mt-1 text-2xl font-bold">{challengerCount}</p>
              </CardContent></Card>
              <Card><CardContent className="px-4 pb-3 pt-4">
                <ShieldCheck className="mb-2 h-4 w-4 text-emerald-400" />
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Family balance</p>
                <p className="mt-1 text-sm font-bold">
                  {Object.entries(counts).map(([family, count]) => `${family}:${count}`).join(' | ') || 'N/A'}
                </p>
              </CardContent></Card>
              <Card><CardContent className="px-4 pb-3 pt-4">
                <Activity className="mb-2 h-4 w-4 text-amber-400" />
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Metadata gaps</p>
                <p className={`mt-1 text-2xl font-bold ${missingMetadata ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {missingMetadata}
                </p>
              </CardContent></Card>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {modelList.map(([name, model]) => <ModelCard key={name} name={name} model={model} />)}
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Recent Lifecycle Events</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
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
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  )
}
