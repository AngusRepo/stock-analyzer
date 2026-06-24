import { loadRuntimeTeacherEvidence } from './runtimeTeacherEvidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function fakeDb(input: {
  rows?: Array<Record<string, unknown>>
  error?: Error
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              ;(fakeDb as any).lastSql = sql
              ;(fakeDb as any).lastArgs = args
              if (input.error) throw input.error
              return { results: input.rows ?? [] }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

async function main(): Promise<void> {
  {
    const db = fakeDb({
      rows: [
        { symbol: '2330', model_name: 'LightGBM', direction_accuracy: 0.82, forecast_data: '{}', prediction_date: '2026-06-11', generated_at: '2026-06-11T09:00:00Z', id: 2 },
        { symbol: '2330', model_name: 'LightGBM', direction_accuracy: 0.4, forecast_data: '{}', prediction_date: '2026-06-10', generated_at: '2026-06-10T09:00:00Z', id: 1 },
        { symbol: '2330', model_name: 'TimesFM', direction_accuracy: null, forecast_data: JSON.stringify({ rank_score: 0.63 }), prediction_date: '2026-06-11', generated_at: '2026-06-11T09:00:00Z', id: 3 },
        { symbol: '2317', model_name: 'XGBoost', direction_accuracy: 77, forecast_data: '{}', prediction_date: '2026-06-11', generated_at: '2026-06-11T09:00:00Z', id: 4 },
      ],
    })

    const result = await loadRuntimeTeacherEvidence(db, ['2330', '2317'], {
      runDate: '2026-06-12',
      lookbackDays: 20,
    })

    assert(result.telemetry.status === 'loaded', 'runtime teacher evidence should load verified historical rows')
    assert(result.telemetry.source === 'predictions_per_model_latest_verified_before_run_date', 'loader source must be explicit')
    assert(result.telemetry.input_scope === 'previous_trading_day_or_latest_verified_teacher_cache', 'loader must document historical cache scope')
    assert(result.telemetry.runtime_teacher_evidence_scope === 'daily_optional_historical_cache_not_same_day_l2_l3_dependency', 'runtime evidence must not depend on same-day L2/L3')
    assert(result.telemetry.label_count === 2, 'loader should count usable direct-alpha labels only')
    assert(result.labels['2330'].LightGBM === 0.82, 'loader should keep latest sorted model score per symbol/model')
    assert(result.labels['2330'].TimesFM == null, 'loader must keep TimesFM out of direct runtime teacher labels')
    assert(result.labels['2317'].XGBoost === 0.77, 'loader should normalize percentage-like rank scores')
    const sql = String((fakeDb as any).lastSql)
    const args = (fakeDb as any).lastArgs as unknown[]
    assert(sql.includes('p.prediction_date < ?'), 'loader must not read same-day L2/L3 predictions')
    assert(sql.includes('p.verified_at IS NOT NULL'), 'loader must require verified teacher cache by default')
    assert(args.includes('2026-06-12'), 'loader should bind runDate as the strict upper bound')
    assert(args.includes('-20 days'), 'loader should bind lookback window')
  }

  {
    const db = fakeDb({ error: new Error('D1 unavailable') })
    const result = await loadRuntimeTeacherEvidence(db, ['2330'], {
      runDate: '2026-06-12',
    })
    assert(result.telemetry.status === 'unavailable', 'loader should fail closed with telemetry on D1 errors')
    assert(Object.keys(result.labels).length === 0, 'unavailable loader should not emit fake labels')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
