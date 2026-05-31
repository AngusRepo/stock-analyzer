import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Boxes, Database, FileJson, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import AppShell from '@/components/AppShell'
import { Button } from '@/components/ui/button'
import {
  WorkstationMetricTile,
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
} from '@/components/workstation/WorkstationChrome'
import { StatusPill, type VisualTone } from '@/components/workstation/VisualPrimitives'
import { modelPoolApi, type ModelArtifactRegistryRow } from '@/lib/api'
import { cn } from '@/lib/utils'

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(4) : '-'
  return String(value)
}

function shortId(value?: string | null): string {
  if (!value) return '-'
  return value.length > 36 ? `${value.slice(0, 18)}...${value.slice(-8)}` : value
}

function toneFromState(value?: string | null): VisualTone {
  const text = String(value ?? '').toLowerCase()
  if (text.includes('pass') || text.includes('approved') || text.includes('promoted') || text.includes('ready')) return 'ok'
  if (text.includes('fail') || text.includes('block') || text.includes('reject')) return 'error'
  if (text.includes('missing') || text.includes('partial') || text.includes('collecting') || text.includes('pending')) return 'warn'
  if (text.includes('shadow') || text.includes('candidate')) return 'info'
  return 'neutral'
}

function parseEvidence(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {}
}

function evidenceKeys(row: ModelArtifactRegistryRow): string {
  const offline = parseEvidence(row.offline_evidence_json)
  const live = parseEvidence(row.live_evidence_json)
  return [...new Set([...Object.keys(offline), ...Object.keys(live)])].slice(0, 6).join(', ') || '-'
}

function registryRows(payload: any): ModelArtifactRegistryRow[] {
  return Array.isArray(payload?.artifacts) ? payload.artifacts : []
}

type InspectorVisualFilter =
  | { kind: 'gate'; value: string }
  | { kind: 'state'; value: string }
  | { kind: 'evidence'; value: string }

function visualToneClass(tone: VisualTone): string {
  if (tone === 'ok') return 'bg-emerald-300 text-emerald-200 border-emerald-400/25'
  if (tone === 'error') return 'bg-rose-300 text-rose-200 border-rose-400/25'
  if (tone === 'warn') return 'bg-amber-300 text-amber-200 border-amber-400/25'
  if (tone === 'info') return 'bg-sky-300 text-sky-200 border-sky-400/25'
  return 'bg-slate-400 text-slate-200 border-slate-500/25'
}

function countBy<T extends string>(rows: ModelArtifactRegistryRow[], getKey: (row: ModelArtifactRegistryRow) => T): Array<{ label: T; count: number }> {
  const counts = new Map<T, number>()
  for (const row of rows) {
    const key = getKey(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)))
}

function gateBucket(row: ModelArtifactRegistryRow): { label: string; tone: VisualTone } {
  const raw = row.live_gate_status ?? row.offline_gate_decision ?? row.offline_gate_status ?? row.state
  const tone = toneFromState(raw)
  if (tone === 'ok') return { label: 'ready', tone }
  if (tone === 'error') return { label: 'blocked', tone }
  if (tone === 'warn') return { label: 'pending', tone }
  if (tone === 'info') return { label: 'shadow/candidate', tone }
  return { label: 'unknown', tone }
}

function evidenceCoverage(row: ModelArtifactRegistryRow): Set<string> {
  const offline = Object.keys(parseEvidence(row.offline_evidence_json)).length > 0
  const live = Object.keys(parseEvidence(row.live_evidence_json)).length > 0
  const tags = new Set<string>()
  if (offline) tags.add('offline evidence')
  if (live) tags.add('live evidence')
  if (!offline && !live) tags.add('missing evidence')
  return tags
}

function applyInspectorVisualFilter(rows: ModelArtifactRegistryRow[], visualFilter: InspectorVisualFilter | null): ModelArtifactRegistryRow[] {
  if (!visualFilter) return rows
  if (visualFilter.kind === 'gate') return rows.filter((row) => gateBucket(row).label === visualFilter.value)
  if (visualFilter.kind === 'state') return rows.filter((row) => String(row.state ?? 'unknown') === visualFilter.value)
  return rows.filter((row) => evidenceCoverage(row).has(visualFilter.value))
}

function visualFilterTestId(kind: InspectorVisualFilter['kind'], value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'
  return `inspector-visual-filter-${kind}-${slug}`
}

function VisualSummaryBar({
  label,
  count,
  total,
  tone,
  detail,
  active,
  onClick,
  testId,
}: {
  label: string
  count: number
  total: number
  tone: VisualTone
  detail?: string
  active?: boolean
  onClick?: () => void
  testId?: string
}) {
  const pct = total > 0 ? Math.max(4, Math.min(100, (count / total) * 100)) : 0
  const toneClass = visualToneClass(tone)
  const interactive = Boolean(onClick)
  return (
    <button
      type="button"
      aria-label={interactive ? `Filter by ${label}` : label}
      aria-pressed={interactive ? Boolean(active) : undefined}
      data-testid={testId}
      disabled={!interactive}
      onClick={onClick}
      className={cn(
        'w-full rounded-xl p-3 text-left transition-colors',
        active ? 'sv-content-card-selected' : 'sv-content-card hover:border-[color:var(--sv-accent-border)]',
        !interactive && 'cursor-default',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="sv-muted-text truncate font-mono text-[10px] uppercase tracking-[0.12em]">{label}</p>
          {detail && <p className="sv-muted-text mt-0.5 truncate text-[10px]">{detail}</p>}
        </div>
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${toneClass.replace(/^bg-\S+\s/, '')}`}>{count}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[color:var(--sv-panel-raised)]">
        <div className={`h-full rounded-full ${toneClass.split(' ')[0]}`} style={{ width: `${pct}%` }} />
      </div>
    </button>
  )
}

function InspectorVisualSummary({
  rows,
  totalRows,
  visualFilter,
  onVisualFilter,
  onReset,
}: {
  rows: ModelArtifactRegistryRow[]
  totalRows: number
  visualFilter: InspectorVisualFilter | null
  onVisualFilter: (filter: InspectorVisualFilter) => void
  onReset: () => void
}) {
  const total = Math.max(1, rows.length)
  const gateRows = countBy(rows, (row) => gateBucket(row).label).map((item) => {
    const first = rows.find((row) => gateBucket(row).label === item.label)
    return { ...item, tone: first ? gateBucket(first).tone : 'neutral' as VisualTone }
  })
  const stateRows = countBy(rows, (row) => String(row.state ?? 'unknown')).slice(0, 6)
  const evidenceRows = [
    {
      label: 'offline evidence',
      count: rows.filter((row) => Object.keys(parseEvidence(row.offline_evidence_json)).length > 0).length,
      tone: 'ok' as VisualTone,
      detail: 'offline_evidence_json has keys',
    },
    {
      label: 'live evidence',
      count: rows.filter((row) => Object.keys(parseEvidence(row.live_evidence_json)).length > 0).length,
      tone: 'info' as VisualTone,
      detail: 'live_evidence_json has keys',
    },
    {
      label: 'missing evidence',
      count: rows.filter((row) =>
        Object.keys(parseEvidence(row.offline_evidence_json)).length === 0 &&
        Object.keys(parseEvidence(row.live_evidence_json)).length === 0,
      ).length,
      tone: 'warn' as VisualTone,
      detail: 'no parsed evidence payload',
    },
  ]

  return (
    <WorkstationPanel
      title="Inspector Visual Summary"
      kicker="gate distribution / state distribution / evidence coverage"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {visualFilter && (
            <button
              type="button"
              data-testid="inspector-visual-summary-reset"
              className="visual-filter-reset sv-surface-chip-accent rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em]"
              onClick={onReset}
            >
              clear {visualFilter.kind}
            </button>
          )}
          <StatusPill tone={rows.length === totalRows ? 'neutral' : 'info'}>{rows.length} / {totalRows}</StatusPill>
        </div>
      }
    >
      <div className="visual-inspector-summary grid gap-3 p-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
        <div className="space-y-3">
          <div>
            <div className="sv-muted-text mb-2 font-mono text-[10px] uppercase tracking-[0.14em]">gate distribution</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {gateRows.map((row) => (
                <VisualSummaryBar
                  key={row.label}
                  label={row.label}
                  count={row.count}
                  total={total}
                  tone={row.tone}
                  active={visualFilter?.kind === 'gate' && visualFilter.value === row.label}
                  onClick={() => onVisualFilter({ kind: 'gate', value: row.label })}
                  testId={visualFilterTestId('gate', row.label)}
                />
              ))}
              {!gateRows.length && <VisualSummaryBar label="no rows" count={0} total={total} tone="neutral" />}
            </div>
          </div>
          <div>
            <div className="sv-muted-text mb-2 font-mono text-[10px] uppercase tracking-[0.14em]">state distribution</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {stateRows.map((row) => (
                <VisualSummaryBar
                  key={row.label}
                  label={row.label}
                  count={row.count}
                  total={total}
                  tone={toneFromState(row.label)}
                  active={visualFilter?.kind === 'state' && visualFilter.value === row.label}
                  onClick={() => onVisualFilter({ kind: 'state', value: row.label })}
                  testId={visualFilterTestId('state', row.label)}
                />
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="sv-muted-text mb-2 font-mono text-[10px] uppercase tracking-[0.14em]">evidence coverage</div>
          <div className="space-y-2">
            {evidenceRows.map((row) => (
              <VisualSummaryBar
                key={row.label}
                label={row.label}
                count={row.count}
                total={total}
                tone={row.tone}
                detail={row.detail}
                active={visualFilter?.kind === 'evidence' && visualFilter.value === row.label}
                onClick={() => onVisualFilter({ kind: 'evidence', value: row.label })}
                testId={visualFilterTestId('evidence', row.label)}
              />
            ))}
          </div>
          <div className="sv-content-card sv-muted-text mt-3 rounded-xl p-3 text-xs leading-5">
            這層只做 raw registry 的快速讀圖；完整 artifact id、gate 欄位與 evidence keys 保留在下方 read-only table。
          </div>
        </div>
      </div>
    </WorkstationPanel>
  )
}

export default function ModelPoolInspectorPage() {
  const [filter, setFilter] = useState('')
  const [visualFilter, setVisualFilter] = useState<InspectorVisualFilter | null>(null)
  const artifactRegistry = useQuery({
    queryKey: ['model-pool', 'artifactRegistry', 'inspector'],
    queryFn: () => modelPoolApi.artifactRegistry(500),
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const rows = registryRows(artifactRegistry.data)
  const textFilteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => [
      row.artifact_id,
      row.model_name,
      row.version,
      row.candidate_type,
      row.state,
      row.offline_gate_decision,
      row.live_gate_status,
      row.promotion_decision,
    ].some((value) => String(value ?? '').toLowerCase().includes(q)))
  }, [filter, rows])
  const filteredRows = useMemo(
    () => applyInspectorVisualFilter(textFilteredRows, visualFilter),
    [textFilteredRows, visualFilter],
  )

  const counts = useMemo(() => {
    const ready = rows.filter((row) => toneFromState(row.live_gate_status ?? row.offline_gate_decision) === 'ok').length
    const blocked = rows.filter((row) => toneFromState(row.live_gate_status ?? row.offline_gate_decision) === 'error').length
    const pending = rows.filter((row) => toneFromState(row.live_gate_status ?? row.offline_gate_decision) === 'warn').length
    const promoted = rows.filter((row) => String(row.promotion_decision ?? '').toLowerCase().includes('promot')).length
    return { ready, blocked, pending, promoted }
  }, [rows])

  return (
    <AppShell>
      <div className="min-h-[100dvh] space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="ModelPool governance"
          title="Raw Artifact Inspector"
          description="獨立檢查 model_artifact_registry 原始列，保留治理頁的高階視覺摘要，也讓 raw evidence 不塞回同一頁。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <WorkstationPill tone={artifactRegistry.isFetching ? 'info' : 'neutral'}>
                {artifactRegistry.isFetching ? 'refreshing' : artifactRegistry.data?.source_of_truth ?? 'registry'}
              </WorkstationPill>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-[color:var(--sv-accent-border)] bg-[color:var(--sv-accent-soft)] text-[color:var(--sv-accent)] hover:bg-[color:var(--sv-accent-soft)]"
                onClick={() => artifactRegistry.refetch()}
              >
                <RefreshCw className={cn('mr-1 h-3.5 w-3.5', artifactRegistry.isFetching && 'animate-spin')} />
                重新整理
              </Button>
            </div>
          }
        />

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <WorkstationMetricTile label="artifacts" value={rows.length} detail="registry rows loaded" tone="info" />
          <WorkstationMetricTile label="ready gates" value={counts.ready} detail="offline/live gate ready" tone={counts.ready ? 'ok' : 'neutral'} />
          <WorkstationMetricTile label="pending evidence" value={counts.pending} detail="missing, partial, collecting" tone={counts.pending ? 'warn' : 'neutral'} />
          <WorkstationMetricTile label="blocked" value={counts.blocked} detail={`promoted ${counts.promoted}`} tone={counts.blocked ? 'error' : 'ok'} />
        </div>

        <InspectorVisualSummary
          rows={textFilteredRows}
          totalRows={rows.length}
          visualFilter={visualFilter}
          onVisualFilter={setVisualFilter}
          onReset={() => setVisualFilter(null)}
        />

        <WorkstationPanel
          title="Registry Filter"
          kicker="read-only artifact table"
          action={<StatusPill tone={artifactRegistry.error ? 'error' : 'ok'}>{artifactRegistry.error ? 'api error' : 'read only'}</StatusPill>}
        >
          <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <label className="relative block">
              <Search className="sv-muted-text pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="filter by model, artifact id, state, gate..."
                className="sv-surface-input h-10 w-full rounded-xl pl-9 pr-3 font-mono text-sm"
              />
            </label>
            <div className="sv-muted-text flex items-center gap-2 text-xs">
              <Database className="h-4 w-4 text-[#7aa2c7]" />
              {filteredRows.length} / {rows.length} rows
              {visualFilter && (
                <button
                  type="button"
                  data-testid="inspector-visual-table-reset"
                  className="visual-filter-reset sv-surface-chip-accent rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em]"
                  onClick={() => setVisualFilter(null)}
                >
                  {visualFilter.kind}: {visualFilter.value}
                </button>
              )}
            </div>
          </div>
        </WorkstationPanel>

        {artifactRegistry.error && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">
            {(artifactRegistry.error as Error).message}
          </div>
        )}

        <WorkstationPanel
          title="Raw Registry Rows"
          kicker="artifact id / gate / evidence preview"
          action={<FileJson className="sv-accent-text h-4 w-4" />}
        >
          <div className="overflow-x-auto">
            <table className="min-w-[1180px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[220px]" />
                <col className="w-[160px]" />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[150px]" />
                <col className="w-[140px]" />
                <col className="w-[140px]" />
                <col className="w-[200px]" />
                <col className="w-[160px]" />
              </colgroup>
              <thead className="sv-data-table-head font-mono uppercase tracking-[0.12em]">
                <tr>
                  <th className="px-3 py-2">artifact</th>
                  <th className="px-3 py-2">model</th>
                  <th className="px-3 py-2">version</th>
                  <th className="px-3 py-2">type</th>
                  <th className="px-3 py-2">state</th>
                  <th className="px-3 py-2">offline</th>
                  <th className="px-3 py-2">live</th>
                  <th className="px-3 py-2">evidence keys</th>
                  <th className="px-3 py-2">updated</th>
                </tr>
              </thead>
              <tbody className="sv-data-table-body divide-y divide-[color:var(--sv-panel-border-soft)]">
                {filteredRows.map((row) => (
                  <tr key={row.artifact_id} className="sv-data-row align-top">
                    <td className="sv-title-text px-3 py-2 font-mono" title={row.artifact_id}>
                      {shortId(row.artifact_id)}
                    </td>
                    <td className="px-3 py-2 font-mono">{fmt(row.model_name)}</td>
                    <td className="px-3 py-2 font-mono">{fmt(row.version)}</td>
                    <td className="px-3 py-2">{fmt(row.candidate_type)}</td>
                    <td className="px-3 py-2">
                      <StatusPill tone={toneFromState(row.state)}>{fmt(row.state)}</StatusPill>
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill tone={toneFromState(row.offline_gate_decision ?? row.offline_gate_status)}>
                        {fmt(row.offline_gate_decision ?? row.offline_gate_status)}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill tone={toneFromState(row.live_gate_status)}>{fmt(row.live_gate_status)}</StatusPill>
                    </td>
                    <td className="sv-muted-text px-3 py-2 font-mono">{evidenceKeys(row)}</td>
                    <td className="sv-muted-text px-3 py-2 font-mono">{fmt(row.updated_at ?? row.created_at)}</td>
                  </tr>
                ))}
                {!filteredRows.length && (
                  <tr>
                    <td colSpan={9} className="sv-muted-text px-3 py-12 text-center">
                      No artifact rows match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </WorkstationPanel>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="sv-content-card sv-muted-text rounded-xl p-3 text-xs leading-5">
            <Boxes className="sv-accent-text mb-2 h-4 w-4" />
            高階 ModelPool 頁保留模型健康與 promotion 決策流，raw registry 改到此頁折疊查證。
          </div>
          <div className="sv-content-card sv-muted-text rounded-xl p-3 text-xs leading-5">
            <ShieldCheck className="mb-2 h-4 w-4 text-emerald-300" />
            此頁只讀資料，不提供 promote/backfill mutation，避免 inspector 變成操作入口。
          </div>
        </div>
      </div>
    </AppShell>
  )
}
