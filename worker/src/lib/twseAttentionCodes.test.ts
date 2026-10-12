import assert from 'node:assert/strict'
import { parseTwseAttentionCodes } from './twseApi'

// Field order and identity columns from the official 2026-10-08 notice response.
const official = {
  stat: 'OK',
  fields: ['編號', '證券代號', '證券名稱', '累計次數', '注意交易資訊', '日期', '收盤價', '本益比'],
  data: [[1, '037060', '鈺邦統一64購01'], [4, '2340', '台亞']],
}
const expected = ['037060', '2340']
assert.deepEqual(parseTwseAttentionCodes(official), expected)
assert.ok(expected.includes('2340'))
assert.deepEqual(parseTwseAttentionCodes({ stat: 'OK', fields: ['證券名稱', '日期', '證券代號'], data: [['台亞', '115.10.08', '2340']] }), ['2340'])
assert.deepEqual(parseTwseAttentionCodes({ stat: 'OK', fields: ['證券名稱'], data: [['2340']] }), [])
assert.deepEqual(parseTwseAttentionCodes({ ...official, stat: 'ERROR' }), [])
assert.deepEqual(parseTwseAttentionCodes({ stat: 'OK', fields: ['證券代號'], data: [null, [], ['台亞'], [' 2340 ']] }), ['2340'])
console.log('TWSE attention: official field order, reordered/missing fields, failure, malformed rows passed')
