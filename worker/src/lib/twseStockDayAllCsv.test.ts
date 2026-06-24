import { parseTwseStockDayAllCsv } from './twseApi'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const csv = [
  'date,symbol,name,volume,amount,open,high,low,close,change,trades',
  '"1150624","2330","TSMC","55,082,816","81,256,153,200","1480.00","1490.00","1465.00","1475.00","+5.00","42,000"',
].join('\r\n')

const parsed = parseTwseStockDayAllCsv(csv, '2026-06-24')

assert(parsed.reportDate === '2026-06-24', 'TWSE CSV ROC report date must convert to ISO date')
assert(parsed.rows.length === 1, 'TWSE CSV parser must return one stock row')
assert(parsed.rows[0].symbol === '2330', 'TWSE CSV parser must read symbol from column 2')
assert(parsed.rows[0].open === 1480, 'TWSE CSV parser must read open from column 6')
assert(parsed.rows[0].high === 1490, 'TWSE CSV parser must read high from column 7')
assert(parsed.rows[0].low === 1465, 'TWSE CSV parser must read low from column 8')
assert(parsed.rows[0].close === 1475, 'TWSE CSV parser must read close from column 9')
assert(parsed.rows[0].volume === 55082816, 'TWSE CSV parser must parse quoted thousands volume')

console.log('twseStockDayAllCsv.test.ts passed')
