import fs from 'node:fs'

const source = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const block = source.slice(
  source.indexOf("'obsidian-sync', () => runObsidianDaily"),
  source.indexOf("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask"),
)
if (!block.includes('critical: false') || !block.includes('timeoutMs: TASK_EXECUTION_TIMEOUT_MS')) {
  throw new Error('Obsidian reporting must be timeout-bounded and non-critical for canonical post-verify closure')
}
