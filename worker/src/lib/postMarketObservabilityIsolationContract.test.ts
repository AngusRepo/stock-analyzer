import fs from 'node:fs'

const source = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const blockStart = source.indexOf("'obsidian-sync', env => runObsidianDaily")
const blockEnd = source.indexOf("'meta-learning-shadow', env => enqueueMetaLearningShadowClosureTask")
if (blockStart < 0 || blockEnd <= blockStart) throw new Error('post-verify obsidian-sync task literal not found')
const block = source.slice(blockStart, blockEnd)
if (!block.includes('critical: false') || !block.includes('timeoutMs: 65_000')) {
  throw new Error('Obsidian reporting must be timeout-bounded and non-critical for canonical post-verify closure')
}
