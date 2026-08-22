import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./pipelineDecisionMaturity.ts', import.meta.url),
  'utf8',
);

if (/state === 'safe_abstention'\s*\?\s*'serving'/.test(source)) {
  throw new Error('safe_abstention must not be presented as a serving candidate');
}

if (!/state === 'safe_abstention'\) return 'evidence_only'/.test(source)) {
  throw new Error('safe_abstention must remain evidence-only while fallback owns production');
}

console.log('pipeline safe-abstention semantic contract passed');
