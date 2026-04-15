/**
 * predictionVerifier.ts
 * 收盤後（16:00）自動驗證預測 + 模擬交易損益
 *
 * 流程：
 * 1. 找出 5 天前、尚未驗證的預測
 * 2. 驗證方向對錯（direction_correct）
 * 3. 模擬交易損益：若依 entry/stop/target 入場，5 天內實際結果如何
 *    → 查每日高低點，判斷是否觸碰 stop_loss / target1 / target2
 *    → 計算 MAE（最大不利波動）/ MFE（最大有利波動）
 * 4. 更新 model_accuracy（含 profit_factor / expectancy）
 * 5. 更新 trade_performance（供前端損益儀表板用）
 * 6. 把盈虧統計存入 stock_memories（讓 LLM 知道模型的真實表現）
 */

interface D1DB {
  prepare(sql: string): D1PreparedStatement
}

interface VerifyEnv {
  DB: D1DB
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
}

export async function runPredictionVerification(envOrDb: D1DB | VerifyEnv): Promise<void> {
  // 向後相容：接受 D1DB 或完整 env
  const db: D1DB = 'DB' in envOrDb ? envOrDb.DB : envOrDb
  const controllerUrl = 'ML_CONTROLLER_URL' in envOrDb ? envOrDb.ML_CONTROLLER_URL : undefined
  const controllerSecret = 'ML_CONTROLLER_SECRET' in envOrDb ? envOrDb.ML_CONTROLLER_SECRET : undefined
  console.log('[Verify] Starting prediction verification + trade simulation...')

  const cutoff = new Date(Date.now() - 5 * 86400000).toISOString()

  const { results: pending } = await db.prepare(`
    SELECT p.*, s.symbol, s.market
    FROM predictions p
    JOIN stocks s ON p.stock_id = s.id
    WHERE p.direction_correct IS NULL
      AND p.generated_at < ?
      AND p.forecast_data IS NOT NULL
    ORDER BY p.generated_at ASC
    LIMIT 200
  `).bind(cutoff).all<any>()

  if (!pending?.length) {
    console.log('[Verify] No pending predictions to verify.')
    return
  }

  console.log(`[Verify] Found ${pending.length} predictions to verify`)

  // 取當下大盤風險
  const marketRiskRow = await db.prepare(
    'SELECT risk_level, risk_score FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  let verified = 0, correct = 0, totalPnl = 0
  const arfBatch: Array<{ stock_id: number; symbol: string; predicted_direction: string; actual_direction: string; realized_pnl_r: number; arf_features: number[]; prediction_id: number }> = []

  for (const pred of pending) {
    try {
      // ── 解析 forecast_data ─────────────────────────────────────────────────
      let forecastData: any = {}
      try { forecastData = JSON.parse(pred.forecast_data) } catch { continue }

      const predictedDirection = forecastData.signal?.includes('BUY') ? 'up'
        : forecastData.signal?.includes('SELL') ? 'down' : 'neutral'

      if (predictedDirection === 'neutral') {
        await db.prepare(
          `UPDATE predictions SET direction_correct=-1, verified_at=datetime('now') WHERE id=?`
        ).bind(pred.id).run()
        continue
      }

      const forecasts: any[] = forecastData.forecasts ?? []
      const predictedPrice: number | null = forecasts[4]?.forecast ?? forecasts[forecasts.length - 1]?.forecast ?? null

      // ── 查詢 5 天內每日 OHLC（用於交易模擬）──────────────────────────────
      const genDate = new Date(pred.generated_at)
      const lookFrom = new Date(genDate.getTime() + 1 * 86400000).toISOString().split('T')[0]
      const lookTo   = new Date(genDate.getTime() + 10 * 86400000).toISOString().split('T')[0]

      const { results: dailyBars } = await db.prepare(`
        SELECT date, open, high, low, close
        FROM stock_prices
        WHERE stock_id=? AND date >= ? AND date <= ?
        ORDER BY date ASC LIMIT 7
      `).bind(pred.stock_id, lookFrom, lookTo).all<any>()

      if (!dailyBars || dailyBars.length < 1) continue  // 資料還沒進來

      // ── 取 5 日後實際收盤（方向驗證用）──────────────────────────────────
      const actualBar = dailyBars[Math.min(4, dailyBars.length - 1)]
      const actualPrice: number = actualBar.close
      const entryPrice: number  = pred.entry_price ?? dailyBars[0]?.open ?? actualPrice
      const stopLoss: number    = pred.stop_loss   ?? entryPrice * (predictedDirection === 'up' ? 0.95 : 1.05)
      const target1: number     = pred.target1     ?? entryPrice * (predictedDirection === 'up' ? 1.05 : 0.95)
      const target2: number     = pred.target2     ?? entryPrice * (predictedDirection === 'up' ? 1.08 : 0.92)

      // 5日報酬率（不管入場，純價格）
      const actualReturnPct = (actualPrice - entryPrice) / entryPrice

      // 實際方向
      const actualDirection = actualPrice > entryPrice * 1.001 ? 'up'
        : actualPrice < entryPrice * 0.999 ? 'down' : 'neutral'
      const isCorrect = predictedDirection === actualDirection ? 1 : 0

      const priceErrorPct = predictedPrice
        ? Math.abs((predictedPrice - actualPrice) / actualPrice) * 100
        : null

      // ── 交易模擬（逐日掃描停損/目標）────────────────────────────────────
      const { outcome, tradePnlPct, tradePnlR, maxFavorable, maxAdverse }
        = simulateTrade(predictedDirection, entryPrice, stopLoss, target1, target2, dailyBars)

      // ── 回填驗證結果 ───────────────────────────────────────────────────────
      await db.prepare(`
        UPDATE predictions SET
          predicted_direction = ?,
          predicted_price     = ?,
          actual_direction    = ?,
          actual_price        = ?,
          direction_correct   = ?,
          price_error_pct     = ?,
          market_risk_level   = ?,
          market_risk_score   = ?,
          actual_return_pct   = ?,
          trade_outcome       = ?,
          trade_pnl_pct       = ?,
          trade_pnl_r         = ?,
          max_favorable_pct   = ?,
          max_adverse_pct     = ?,
          verified_at         = datetime('now')
        WHERE id = ?
      `).bind(
        predictedDirection, predictedPrice,
        actualDirection, actualPrice,
        isCorrect, priceErrorPct,
        marketRiskRow?.risk_level ?? null,
        marketRiskRow?.risk_score ?? null,
        actualReturnPct,
        outcome,
        tradePnlPct,
        tradePnlR,
        maxFavorable,
        maxAdverse,
        pred.id,
      ).run()

      verified++
      if (isCorrect) correct++
      totalPnl += tradePnlPct ?? 0

      // ARF feedback 收集（Controller 批次更新用）
      if (forecastData.arf_features?.length) {
        arfBatch.push({
          stock_id: pred.stock_id,
          symbol: pred.symbol,
          predicted_direction: predictedDirection,
          actual_direction: actualDirection,
          realized_pnl_r: tradePnlR,
          arf_features: forecastData.arf_features,
          prediction_id: pred.id,
        })
      }

    } catch (e) {
      console.error(`[Verify] Failed pred ${pred.id}:`, e)
    }
  }

  console.log(
    `[Verify] Verified ${verified}, correct ${correct}` +
    ` (${verified ? ((correct / verified) * 100).toFixed(1) : 0}%)` +
    ` total simulated PnL: ${(totalPnl * 100).toFixed(1)}%`
  )

  // ── 更新準確率 + 盈虧統計 ───────────────────────────────────────────────
  await updateModelAccuracy(db)
  await updateTradePerformance(db)
  await updateStockMemories(db)

  // ── ARF/LinUCB 在線學習（透過 Controller → Modal update_arf_reward）────
  if (arfBatch.length && controllerUrl) {
    try {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
      const res = await fetch(`${controllerUrl}/verify`, {
        method: 'POST', headers,
        body: JSON.stringify({ date: today, verifications: arfBatch }),
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) {
        const data = await res.json() as any
        console.log(`[Verify] ARF feedback: ${data.updated} updated via Controller`)
      } else {
        console.warn(`[Verify] ARF Controller HTTP ${res.status}`)
      }
    } catch (e) {
      console.warn('[Verify] ARF Controller call failed (non-blocking):', e)
    }
  }
}


// ── 交易模擬引擎 ──────────────────────────────────────────────────────────────
// Phase 5.2 (2026-04-08): exported for parity test against Python port
export function simulateTrade(
  direction: 'up' | 'down',
  entry: number,
  stop: number,
  target1: number,
  target2: number,
  bars: any[]
): { outcome: string; tradePnlPct: number; tradePnlR: number; maxFavorable: number; maxAdverse: number } {

  const isLong = direction === 'up'
  const riskPerShare = Math.abs(entry - stop)  // 1R

  let maxFavorable    = 0  // MFE：持倉期間最大有利方向波動
  let maxAdverse      = 0  // MAE：持倉期間最大不利方向波動
  let outcome         = 'expired'
  let exitPrice       = bars[bars.length - 1]?.close ?? entry
  let hitTarget1      = false  // 已觸及 target1 後不再被止損出場

  for (const bar of bars) {
    const high = bar.high ?? bar.close
    const low  = bar.low  ?? bar.close

    // 多方：high 看目標，low 看停損
    if (isLong) {
      const favorable = (high - entry) / entry
      const adverse   = (entry - low) / entry
      maxFavorable = Math.max(maxFavorable, favorable)
      maxAdverse   = Math.max(maxAdverse, adverse)

      if (high >= target2) {
        outcome   = 'hit_target2'
        exitPrice = target2
        break
      }
      if (high >= target1) {
        outcome     = 'hit_target1'
        exitPrice   = target1
        hitTarget1  = true
        // 不 break：繼續看是否達到 target2
      }
      // 已觸及 target1 後不再被原始止損出場（視為已部分獲利鎖定）
      if (!hitTarget1 && low <= stop) {
        outcome   = 'hit_stop'
        exitPrice = stop
        break
      }
    } else {
      // 空方：low 看目標，high 看停損
      const favorable = (entry - low) / entry
      const adverse   = (high - entry) / entry
      maxFavorable = Math.max(maxFavorable, favorable)
      maxAdverse   = Math.max(maxAdverse, adverse)

      if (low <= target2) {
        outcome   = 'hit_target2'
        exitPrice = target2
        break
      }
      if (low <= target1) {
        outcome    = 'hit_target1'
        exitPrice  = target1
        hitTarget1 = true
      }
      if (!hitTarget1 && high >= stop) {
        outcome   = 'hit_stop'
        exitPrice = stop
        break
      }
    }
  }

  // 計算損益
  const rawPnl = isLong
    ? (exitPrice - entry) / entry
    : (entry - exitPrice) / entry

  const tradePnlR = riskPerShare > 0 ? rawPnl * entry / riskPerShare : 0

  return {
    outcome,
    tradePnlPct: Math.round(rawPnl * 10000) / 10000,
    tradePnlR:   Math.round(tradePnlR * 100) / 100,
    maxFavorable: Math.round(maxFavorable * 10000) / 10000,
    maxAdverse:   Math.round(maxAdverse * 10000) / 10000,
  }
}


// ── model_accuracy 更新（含 profit_factor）────────────────────────────────────
async function updateModelAccuracy(db: D1DB): Promise<void> {
  const { results: groups } = await db.prepare(`
    SELECT DISTINCT stock_id, model_name FROM predictions
    WHERE direction_correct IN (0, 1)
  `).all<any>()

  for (const g of (groups ?? [])) {
    await upsertAccuracy(db, g.stock_id, g.model_name, 'all', null)
    await upsertAccuracy(db, g.stock_id, g.model_name, '30d',
      new Date(Date.now() - 30 * 86400000).toISOString())
    await upsertAccuracy(db, g.stock_id, g.model_name, '90d',
      new Date(Date.now() - 90 * 86400000).toISOString())
  }
  console.log(`[Verify] model_accuracy updated for ${groups?.length ?? 0} groups`)
}

async function upsertAccuracy(
  db: D1DB, stockId: number, modelName: string,
  period: string, since: string | null
): Promise<void> {
  const whereBase = since
    ? 'stock_id=? AND model_name=? AND direction_correct IN (0,1) AND generated_at >= ?'
    : 'stock_id=? AND model_name=? AND direction_correct IN (0,1)'
  const params = since ? [stockId, modelName, since] : [stockId, modelName]

  // 基本準確率
  const row = await db.prepare(
    `SELECT COUNT(*) as total, SUM(direction_correct) as correct,
            AVG(price_error_pct) as avg_err
     FROM predictions WHERE ${whereBase}`
  ).bind(...params).first<any>()
  if (!row || row.total < 1) return

  // 市況分層（market_risk_level 實際值為 'green'|'yellow'|'orange'|'red'|'black'）
  const lowRisk = await db.prepare(
    `SELECT COUNT(*) as total, SUM(direction_correct) as correct
     FROM predictions WHERE ${whereBase} AND market_risk_level IN ('green','yellow')`
  ).bind(...params).first<any>()
  const highRisk = await db.prepare(
    `SELECT COUNT(*) as total, SUM(direction_correct) as correct
     FROM predictions WHERE ${whereBase} AND market_risk_level IN ('red','black')`
  ).bind(...params).first<any>()

  // 盈虧品質指標
  const winRows = await db.prepare(
    `SELECT AVG(actual_return_pct) as avg_win
     FROM predictions WHERE ${whereBase} AND direction_correct=1 AND actual_return_pct IS NOT NULL`
  ).bind(...params).first<any>()
  const lossRows = await db.prepare(
    `SELECT AVG(actual_return_pct) as avg_loss
     FROM predictions WHERE ${whereBase} AND direction_correct=0 AND actual_return_pct IS NOT NULL`
  ).bind(...params).first<any>()

  // 模擬交易統計
  const tradeRows = await db.prepare(
    `SELECT AVG(trade_pnl_pct) as avg_pnl,
            AVG(trade_pnl_r) as avg_r,
            SUM(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct ELSE 0 END) as gross_profit,
            SUM(CASE WHEN trade_pnl_pct < 0 THEN ABS(trade_pnl_pct) ELSE 0 END) as gross_loss,
            SUM(CASE WHEN trade_outcome='hit_target1' OR trade_outcome='hit_target2' THEN 1 ELSE 0 END) as hit_target,
            SUM(CASE WHEN trade_outcome='hit_stop' THEN 1 ELSE 0 END) as hit_stop,
            COUNT(CASE WHEN trade_pnl_pct IS NOT NULL THEN 1 END) as trade_count
     FROM predictions WHERE ${whereBase}`
  ).bind(...params).first<any>()

  const accuracy  = row.correct / row.total
  const accLow    = lowRisk?.total  > 0 ? lowRisk.correct  / lowRisk.total  : null
  const accHigh   = highRisk?.total > 0 ? highRisk.correct / highRisk.total : null
  const avgWin    = winRows?.avg_win  ?? null
  const avgLoss   = lossRows?.avg_loss ?? null
  const profitFactor = tradeRows?.gross_loss > 0
    ? (tradeRows.gross_profit / tradeRows.gross_loss) : null

  // 期望值 = 勝率×平均獲利 + 敗率×平均虧損（avgLoss 是負數）
  const winRate  = accuracy
  const expectancy = (avgWin !== null && avgLoss !== null)
    ? winRate * avgWin + (1 - winRate) * avgLoss
    : null

  const hitTargetRate = tradeRows?.trade_count > 0
    ? tradeRows.hit_target / tradeRows.trade_count : null
  const hitStopRate = tradeRows?.trade_count > 0
    ? tradeRows.hit_stop / tradeRows.trade_count : null

  await db.prepare(`
    INSERT INTO model_accuracy (
      stock_id, model_name, period,
      total_count, correct_count, accuracy, avg_price_error,
      accuracy_in_low_risk, accuracy_in_high_risk, count_low_risk, count_high_risk,
      avg_win_pct, avg_loss_pct, profit_factor, avg_trade_pnl, avg_trade_pnl_r,
      hit_target_rate, hit_stop_rate, expectancy,
      last_updated
    ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?, datetime('now'))
    ON CONFLICT(stock_id, model_name, period) DO UPDATE SET
      total_count          = excluded.total_count,
      correct_count        = excluded.correct_count,
      accuracy             = excluded.accuracy,
      avg_price_error      = excluded.avg_price_error,
      accuracy_in_low_risk = excluded.accuracy_in_low_risk,
      accuracy_in_high_risk= excluded.accuracy_in_high_risk,
      count_low_risk       = excluded.count_low_risk,
      count_high_risk      = excluded.count_high_risk,
      avg_win_pct          = excluded.avg_win_pct,
      avg_loss_pct         = excluded.avg_loss_pct,
      profit_factor        = excluded.profit_factor,
      avg_trade_pnl        = excluded.avg_trade_pnl,
      avg_trade_pnl_r      = excluded.avg_trade_pnl_r,
      hit_target_rate      = excluded.hit_target_rate,
      hit_stop_rate        = excluded.hit_stop_rate,
      expectancy           = excluded.expectancy,
      last_updated         = datetime('now')
  `).bind(
    stockId, modelName, period,
    row.total, row.correct, accuracy, row.avg_err,
    accLow, accHigh, lowRisk?.total ?? 0, highRisk?.total ?? 0,
    avgWin, avgLoss, profitFactor,
    tradeRows?.avg_pnl ?? null, tradeRows?.avg_r ?? null,
    hitTargetRate, hitStopRate, expectancy,
  ).run()
}


// ── trade_performance 彙總表更新 ─────────────────────────────────────────────
async function updateTradePerformance(db: D1DB): Promise<void> {
  const { results: groups } = await db.prepare(`
    SELECT DISTINCT stock_id, model_name FROM predictions
    WHERE trade_pnl_pct IS NOT NULL
  `).all<any>()

  for (const g of (groups ?? [])) {
    await upsertTradePerf(db, g.stock_id, g.model_name, 'all', null)
    await upsertTradePerf(db, g.stock_id, g.model_name, '30d',
      new Date(Date.now() - 30 * 86400000).toISOString())
    await upsertTradePerf(db, g.stock_id, g.model_name, '90d',
      new Date(Date.now() - 90 * 86400000).toISOString())
  }
  console.log(`[Verify] trade_performance updated for ${groups?.length ?? 0} groups`)
}

async function upsertTradePerf(
  db: D1DB, stockId: number, modelName: string,
  period: string, since: string | null
): Promise<void> {
  const whereBase = since
    ? 'stock_id=? AND model_name=? AND trade_pnl_pct IS NOT NULL AND generated_at >= ?'
    : 'stock_id=? AND model_name=? AND trade_pnl_pct IS NOT NULL'
  const params = since ? [stockId, modelName, since] : [stockId, modelName]

  const row = await db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN trade_pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN trade_pnl_pct < 0 THEN 1 ELSE 0 END) as losses,
      SUM(trade_pnl_pct) as total_pnl,
      AVG(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct END) as avg_win,
      AVG(CASE WHEN trade_pnl_pct < 0 THEN trade_pnl_pct END) as avg_loss,
      MAX(trade_pnl_pct) as max_win,
      MIN(trade_pnl_pct) as max_loss,
      SUM(CASE WHEN trade_pnl_pct > 0 THEN trade_pnl_pct ELSE 0 END) as gross_profit,
      SUM(CASE WHEN trade_pnl_pct < 0 THEN ABS(trade_pnl_pct) ELSE 0 END) as gross_loss,
      AVG(trade_pnl_r) as avg_r,
      SUM(CASE WHEN trade_outcome='hit_target1' THEN 1 ELSE 0 END) as hit_t1,
      SUM(CASE WHEN trade_outcome='hit_target2' THEN 1 ELSE 0 END) as hit_t2,
      SUM(CASE WHEN trade_outcome='hit_stop'    THEN 1 ELSE 0 END) as hit_stop,
      SUM(CASE WHEN trade_outcome='expired'     THEN 1 ELSE 0 END) as expired,
      AVG(max_favorable_pct) as avg_mfe,
      AVG(max_adverse_pct)   as avg_mae
    FROM predictions WHERE ${whereBase}
  `).bind(...params).first<any>()

  if (!row || row.total < 1) return

  const profitFactor = row.gross_loss > 0 ? row.gross_profit / row.gross_loss : null
  const winRate = row.wins / row.total
  const expectancy = (row.avg_win !== null && row.avg_loss !== null)
    ? winRate * row.avg_win + (1 - winRate) * row.avg_loss
    : null

  await db.prepare(`
    INSERT INTO trade_performance (
      stock_id, model_name, period,
      total_trades, win_trades, loss_trades, total_pnl_pct,
      avg_win_pct, avg_loss_pct, max_win_pct, max_loss_pct,
      profit_factor, expectancy, avg_pnl_r,
      hit_target1_count, hit_target2_count, hit_stop_count, expired_count,
      avg_mfe, avg_mae, last_updated
    ) VALUES (?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,datetime('now'))
    ON CONFLICT(stock_id, model_name, period) DO UPDATE SET
      total_trades      = excluded.total_trades,
      win_trades        = excluded.win_trades,
      loss_trades       = excluded.loss_trades,
      total_pnl_pct     = excluded.total_pnl_pct,
      avg_win_pct       = excluded.avg_win_pct,
      avg_loss_pct      = excluded.avg_loss_pct,
      max_win_pct       = excluded.max_win_pct,
      max_loss_pct      = excluded.max_loss_pct,
      profit_factor     = excluded.profit_factor,
      expectancy        = excluded.expectancy,
      avg_pnl_r         = excluded.avg_pnl_r,
      hit_target1_count = excluded.hit_target1_count,
      hit_target2_count = excluded.hit_target2_count,
      hit_stop_count    = excluded.hit_stop_count,
      expired_count     = excluded.expired_count,
      avg_mfe           = excluded.avg_mfe,
      avg_mae           = excluded.avg_mae,
      last_updated      = datetime('now')
  `).bind(
    stockId, modelName, period,
    row.total, row.wins, row.losses, row.total_pnl,
    row.avg_win, row.avg_loss, row.max_win, row.max_loss,
    profitFactor, expectancy, row.avg_r,
    row.hit_t1, row.hit_t2, row.hit_stop, row.expired,
    row.avg_mfe, row.avg_mae,
  ).run()
}


// ── stock_memories 更新（讓 LLM 知道模型真實績效）─────────────────────────────
async function updateStockMemories(db: D1DB): Promise<void> {
  const { results: stocks } = await db.prepare(
    'SELECT DISTINCT stock_id FROM trade_performance WHERE period=\'all\''
  ).all<any>()

  for (const { stock_id } of (stocks ?? [])) {
    const { results: perfs } = await db.prepare(`
      SELECT model_name, total_trades, profit_factor, expectancy,
             avg_win_pct, avg_loss_pct, avg_pnl_r, hit_target1_count, hit_stop_count
      FROM trade_performance
      WHERE stock_id=? AND period='all' AND total_trades >= 5
      ORDER BY profit_factor DESC NULLS LAST
    `).bind(stock_id).all<any>()

    if (!perfs?.length) continue

    const perfStr = perfs.map((p: any) => {
      const pf   = p.profit_factor ? `獲利因子 ${p.profit_factor.toFixed(2)}` : ''
      const exp  = p.expectancy ? `期望值 ${(p.expectancy * 100).toFixed(1)}%` : ''
      const win  = p.avg_win_pct  ? `平均獲利 ${(p.avg_win_pct * 100).toFixed(1)}%` : ''
      const loss = p.avg_loss_pct ? `平均虧損 ${(p.avg_loss_pct * 100).toFixed(1)}%` : ''
      const r    = p.avg_pnl_r    ? `平均 ${p.avg_pnl_r.toFixed(2)}R` : ''
      return `${p.model_name}（${p.total_trades}筆）：${[pf, exp, win, loss, r].filter(Boolean).join('，')}`
    }).join('\n')

    const content = `【交易模擬績效 - 依建議價位入場】\n${perfStr}`

    await db.prepare(`
      INSERT INTO stock_memories (stock_id, memory_type, content, sample_count, updated_at)
      VALUES (?, 'trade_performance', ?, ?, datetime('now'))
      ON CONFLICT(stock_id, memory_type) DO UPDATE SET
        content=excluded.content, sample_count=excluded.sample_count, updated_at=datetime('now')
    `).bind(stock_id, content, perfs.length).run().catch(() => {})
  }

  // 同步更新 model_accuracy 記憶
  const { results: allStocks } = await db.prepare(
    'SELECT DISTINCT stock_id FROM model_accuracy'
  ).all<any>()

  for (const { stock_id } of (allStocks ?? [])) {
    const { results: accuracies } = await db.prepare(`
      SELECT model_name, accuracy, total_count, period
      FROM model_accuracy
      WHERE stock_id=? AND period IN ('30d','all')
      ORDER BY model_name, period
    `).bind(stock_id).all<any>()

    if (!accuracies?.length) continue

    const modelStats = accuracies
      .filter((a: any) => a.period === 'all' && a.total_count >= 5)
      .map((a: any) => `${a.model_name} 歷史方向準確率 ${(a.accuracy * 100).toFixed(0)}%（${a.total_count} 次）`)
      .join('；')

    const recent = accuracies
      .filter((a: any) => a.period === '30d' && a.total_count >= 3)
      .map((a: any) => `${a.model_name} 近 30 日 ${(a.accuracy * 100).toFixed(0)}%`)
      .join('；')

    if (!modelStats && !recent) continue

    const content = [
      modelStats && `【模型歷史準確率】${modelStats}`,
      recent     && `【近期表現】${recent}`,
    ].filter(Boolean).join('\n')

    await db.prepare(`
      INSERT INTO stock_memories (stock_id, memory_type, content, sample_count, updated_at)
      VALUES (?, 'model_accuracy', ?, ?, datetime('now'))
      ON CONFLICT(stock_id, memory_type) DO UPDATE SET
        content=excluded.content, sample_count=excluded.sample_count, updated_at=datetime('now')
    `).bind(stock_id, content, accuracies.length).run().catch(() => {})
  }

  console.log(`[Verify] stock_memories updated`)
}
