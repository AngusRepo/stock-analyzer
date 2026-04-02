import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const quantileColor = ['', 'text-red-400', 'text-orange-400', 'text-yellow-400', 'text-emerald-400', 'text-green-400']

function FactorBar({ label, z, max = 3 }: { label: string; z: number | null; max?: number }) {
  if (z == null) return null
  const pct = Math.min(100, Math.max(0, ((z + max) / (max * 2)) * 100))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span className="font-mono">{z.toFixed(2)}</span></div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function FactorAnalysis({ stockId }: { stockId: number }) {
  const { data: factor, isLoading } = useQuery({
    queryKey: ['stocks', stockId, 'factors'],
    queryFn: () => stocksApi.factors(stockId),
    enabled: !!stockId,
  })

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!factor || (factor as any).empty) return (
    <div className="text-sm text-muted-foreground text-center py-8">
      {(factor as any)?.reason ?? '暫無因子分析'}
    </div>
  )

  const f = factor as any
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div>
          <p className="text-xs text-muted-foreground">綜合因子分數</p>
          <p className="text-3xl font-bold font-mono">{f.composite_score?.toFixed(2) ?? '—'}</p>
        </div>
        <div className={cn('text-4xl font-bold', quantileColor[f.quantile ?? 0])}>Q{f.quantile ?? '—'}</div>
      </div>
      <div className="space-y-2.5">
        <FactorBar label="動能因子 (Z)" z={f.z_momentum} />
        <FactorBar label="價值因子 (Z)" z={f.z_value} />
        <FactorBar label="品質因子 (Z)" z={f.z_quality} />
      </div>
    </div>
  )
}
