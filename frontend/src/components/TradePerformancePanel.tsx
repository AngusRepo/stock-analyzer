/**
 * TradePerformancePanel.tsx
 * 模型交易模擬績效儀表板
 * 顯示：累計損益 / 勝率 / 獲利因子 / 期望值 / 出場分佈 / 逐筆記錄
 */
import { useQuery } from '@tanstack/react-query'
import { tradeApi } from '@/lib/api'
import { marketRiskLevelStyle } from '@/lib/marketRiskLevel'
import { priceToneClass, STATUS_TEXT, type StatusTone } from '@/lib/colorTokens'
import { StatusIcon } from '@/components/ui/status'

interface TradePerf {
  model_name: string
  period: string
  total_trades: number
  win_trades: number
  loss_trades: number
  total_pnl_pct: number | null
  avg_win_pct: number | null
  avg_loss_pct: number | null
  max_win_pct: number | null
  max_loss_pct: number | null
  profit_factor: number | null
  expectancy: number | null
  avg_pnl_r: number | null
  hit_target1_count: number
  hit_target2_count: number
  hit_stop_count: number
  expired_count: number
  avg_mfe: number | null
  avg_mae: number | null
}

interface TradeRecord {
  generated_at: string
  model_name: string
  trade_signal: string
  predicted_direction: string
  actual_direction: string
  direction_correct: number
  entry_price: number
  stop_loss: number
  target1: number
  trade_outcome: string | null
  trade_pnl_pct: number | null
  trade_pnl_r: number | null
  max_favorable_pct: number | null
  max_adverse_pct: number | null
  market_risk_level: string | null
  verified_at: string | null
}

const pct  = (v: number | null) => v == null ? 'N/A' : `${(v * 100).toFixed(2)}%`
const sign = (v: number | null) => v == null ? 'N/A' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const r    = (v: number | null) => v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`

const outcomeLabel: Record<string, { label: string; color: string }> = {
  hit_target2: { label: '達目標 2 ✦', color: 'text-up' },
  hit_target1: { label: '達目標 1 ✓', color: 'text-up' },
  hit_stop:    { label: '觸停損 ✗',   color: 'text-down' },
  expired:     { label: '到期平倉',   color: 'text-gray-400' },
}

function StatCard({ label, value, sub, color = 'text-white', tone }: {
  label: string; value: string; sub?: string; color?: string; tone?: StatusTone
}) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 flex flex-col gap-1">
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`inline-flex items-center gap-1.5 text-lg font-bold sv-num ${tone ? STATUS_TEXT[tone] : color}`}>{tone && <StatusIcon tone={tone} size={12} />}{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  )
}

export default function TradePerformancePanel({ stockId }: { stockId: number }) {
  const [period, setPeriod] = React.useState<'all' | '30d' | '90d'>('all')
  const [selectedModel, setSelectedModel] = React.useState<string>('ensemble')

  const { data: perfs = [], isLoading } = useQuery({
    queryKey: ['trade-performance', stockId],
    queryFn: () => tradeApi.performance(stockId) as Promise<TradePerf[]>,
    staleTime: 5 * 60_000,
  })

  const { data: history = [] } = useQuery({
    queryKey: ['trade-history', stockId],
    queryFn: () => tradeApi.history(stockId, 30) as Promise<TradeRecord[]>,
    staleTime: 5 * 60_000,
  })

  const periodPerfs = perfs.filter(p => p.period === period)
  const models: string[] = [...new Set(periodPerfs.map(p => p.model_name))]
  const perf = periodPerfs.find(p => p.model_name === selectedModel) ?? periodPerfs[0]

  if (isLoading) return (
    <div className="text-center text-muted-foreground py-8">載入交易模擬績效中...</div>
  )

  if (!periodPerfs.length) return (
    <div className="text-center text-muted-foreground py-8">
      <p>尚無驗證資料</p>
      <p className="text-xs mt-1">每日 16:00 驗證 Cron 執行後開始累積</p>
    </div>
  )

  const winRate = perf ? perf.win_trades / perf.total_trades : 0

  return (
    <div className="space-y-4">
      {/* 控制列 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-md overflow-hidden border border-gray-700">
          {(['all', '90d', '30d'] as const).map(p => (
            <button key={p}
              className={`px-3 py-1 text-xs font-medium transition-colors ${period === p ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
              onClick={() => setPeriod(p)}>
              {p === 'all' ? '全部' : p}
            </button>
          ))}
        </div>
        <div className="flex rounded-md overflow-hidden border border-gray-700">
          {models.map(m => (
            <button key={m}
              className={`px-3 py-1 text-xs font-medium transition-colors ${selectedModel === m ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
              onClick={() => setSelectedModel(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>

      {perf && (
        <>
          {/* 主要指標卡片 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard
              label="累計模擬損益"
              value={sign(perf.total_pnl_pct)}
              sub={`共 ${perf.total_trades} 筆`}
              color={perf.total_pnl_pct == null ? 'text-white' : priceToneClass(perf.total_pnl_pct)}
            />
            <StatCard
              label="獲利因子"
              value={perf.profit_factor ? perf.profit_factor.toFixed(2) : 'N/A'}
              sub="毛利 ÷ 毛損，> 1 為正期望"
              tone={perf.profit_factor == null ? undefined
                : perf.profit_factor >= 1.5 ? 'ok'
                : perf.profit_factor >= 1.0 ? 'warn' : 'fail'}
            />
            <StatCard
              label="期望值 / 每筆"
              value={sign(perf.expectancy)}
              sub={r(perf.avg_pnl_r)}
              color={perf.expectancy == null ? 'text-white' : priceToneClass(perf.expectancy)}
            />
            <StatCard
              label="勝率"
              value={`${(winRate * 100).toFixed(0)}%`}
              sub={`${perf.win_trades}勝 ${perf.loss_trades}敗`}
              tone={winRate >= 0.55 ? 'ok' : winRate >= 0.45 ? 'warn' : 'fail'}
            />
          </div>

          {/* 盈虧不對稱性 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="平均獲利"  value={sign(perf.avg_win_pct)}  color={priceToneClass(perf.avg_win_pct)} />
            <StatCard label="平均虧損"  value={sign(perf.avg_loss_pct)} color={priceToneClass(perf.avg_loss_pct)} />
            <StatCard label="最大單筆獲利" value={sign(perf.max_win_pct)} color={priceToneClass(perf.max_win_pct)} />
            <StatCard label="最大單筆虧損" value={sign(perf.max_loss_pct)} color={priceToneClass(perf.max_loss_pct)} />
          </div>

          {/* 出場分佈 */}
          <div className="bg-gray-800 rounded-lg p-3">
            <p className="text-xs text-gray-400 mb-2">出場結果分佈</p>
            <div className="flex gap-3 flex-wrap text-xs">
              <span className="text-up">達目標2: {perf.hit_target2_count}</span>
              <span className="text-up">達目標1: {perf.hit_target1_count}</span>
              <span className="text-down">觸停損: {perf.hit_stop_count}</span>
              <span className="text-gray-400">到期: {perf.expired_count}</span>
            </div>
            {/* 視覺化條形 */}
            {perf.total_trades > 0 && (
              <div className="flex h-3 mt-2 rounded overflow-hidden gap-0.5">
                {perf.hit_target2_count > 0 && <div className="bg-up"     style={{ flex: perf.hit_target2_count }} />}
                {perf.hit_target1_count > 0 && <div className="bg-up/70"     style={{ flex: perf.hit_target1_count }} />}
                {perf.expired_count > 0      && <div className="bg-gray-600"   style={{ flex: perf.expired_count }} />}
                {perf.hit_stop_count > 0     && <div className="bg-down" style={{ flex: perf.hit_stop_count }} />}
              </div>
            )}
          </div>

          {/* MAE / MFE */}
          {(perf.avg_mfe || perf.avg_mae) && (
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="平均最大有利波動 (MFE)" value={pct(perf.avg_mfe)} sub="若分批出場的最大潛在" color="text-up" />
              <StatCard label="平均最大不利波動 (MAE)" value={pct(perf.avg_mae)} sub="持倉期間最深回撤" color="text-down" />
            </div>
          )}
        </>
      )}

      {/* 逐筆記錄 */}
      {history.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-2">最近交易記錄（{history.length} 筆）</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-muted-foreground border-b border-gray-700">
                  <th className="text-left py-1 pr-2">日期</th>
                  <th className="text-left py-1 pr-2">模型</th>
                  <th className="text-left py-1 pr-2">訊號</th>
                  <th className="text-left py-1 pr-2">出場</th>
                  <th className="text-right py-1 pr-2">損益%</th>
                  <th className="text-right py-1 pr-2">R</th>
                  <th className="text-left py-1">市況</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => {
                  const oc = outcomeLabel[h.trade_outcome ?? ''] ?? { label: '未驗證', color: 'text-muted-foreground' }
                  const pnl = h.trade_pnl_pct
                  return (
                    <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/50">
                      <td className="py-1 pr-2 text-gray-400">{h.generated_at.slice(0, 10)}</td>
                      <td className="py-1 pr-2">{h.model_name}</td>
                      <td className="py-1 pr-2">
                        <span className={h.predicted_direction === 'up' ? 'text-up' : 'text-down'}>
                          {h.trade_signal}
                        </span>
                      </td>
                      <td className={`py-1 pr-2 ${oc.color}`}>{oc.label}</td>
                      <td className={`py-1 pr-2 text-right sv-num ${pnl == null ? 'text-muted-foreground' : priceToneClass(pnl)}`}>
                        {pnl == null ? '-' : `${pnl >= 0 ? '+' : ''}${(pnl * 100).toFixed(2)}%`}
                      </td>
                      <td className={`py-1 pr-2 text-right sv-num ${!h.trade_pnl_r ? 'text-muted-foreground' : priceToneClass(h.trade_pnl_r)}`}>
                        {h.trade_pnl_r == null ? '-' : r(h.trade_pnl_r)}
                      </td>
                      <td className={`py-1 text-xs ${marketRiskLevelStyle(h.market_risk_level).color}`}>
                        {h.market_risk_level ?? '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-2">
        ⚠️ 模擬交易：假設依系統建議 entry_price 入場，持倉至觸碰停損/目標或 5 日到期。
        不含手續費、滑價、稅。僅供模型評估用，非實際交易建議。
      </p>
    </div>
  )
}

import React from 'react'
