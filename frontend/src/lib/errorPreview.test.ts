import assert from 'node:assert/strict'
import test from 'node:test'
import { clipErrorText, ERROR_PREVIEW_CHAR_LIMIT } from './errorPreview'

test('R4-1: errors up to 600 characters show in full; longer ones are cut with the full length noted', () => {
  assert.equal(ERROR_PREVIEW_CHAR_LIMIT, 600)
  const short = '錯'.repeat(600)
  assert.deepEqual(clipErrorText(short), { text: short, clipped: false, length: 600 })
  const long = `${'錯'.repeat(600)}尾巴`
  const clipped = clipErrorText(long)
  assert.equal(clipped.clipped, true)
  assert.equal(clipped.text, `${'錯'.repeat(600)}…（全文 602 字，見 title）`)
  // Counted in Unicode characters, so an emoji is never split in half.
  const emoji = '😀'.repeat(601)
  assert.equal(Array.from(clipErrorText(emoji).text.split('…')[0]).length, 600)
})
