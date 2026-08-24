import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('price horizon persistence keeps label and rejection terminal states mutually exclusive', () => {
  const source = fs.readFileSync('src/lib/priceHorizonProjection.ts', 'utf8')

  assert.match(source, /async function deleteResolvedRejections/)
  assert.match(source, /DELETE FROM price_horizon_label_rejections_v1/)
  assert.match(source, /observations\.labels\.map\(\(row\) => row\.stockId\)/)

  assert.match(source, /async function deleteRejectedLabels/)
  assert.match(source, /DELETE FROM price_horizon_labels_v1/)
  assert.match(source, /observations\.rejections\.map\(\(row\) => row\.stockId\)/)
})
