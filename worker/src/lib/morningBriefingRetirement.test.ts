import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { getSchedulerDependencySpec } from './schedulerDependencyMap'
import { schedulerManifestJobs } from './schedulerManifestGovernance'

test('morning briefing cannot be recreated, triggered, or displayed after retirement', () => {
  assert.ok(schedulerManifest.deleteJobIds.includes('morning-briefing'))
  assert.ok(!schedulerManifestJobs().some(job => job.id === 'morning-briefing' || job.task === 'morning-briefing'))
  assert.equal(getSchedulerDependencySpec('morning-briefing'), undefined)
  assert.ok(!existsSync('src/lib/morningBriefing.ts'))
  for (const path of ['src/lib/adminTriggerWorkerDomainTasks.ts', 'src/lib/cronWorkerDomainTasks.ts',
    'src/lib/schedulerStatus.ts', 'src/lib/schedulerPolicy.ts', 'src/lib/schedulerRunLogger.ts',
    '../frontend/src/components/observability/ExecutionChainPanel.tsx']) {
    assert.ok(!readFileSync(path, 'utf8').includes('morning-briefing'), path)
  }
  for (const task of ['us-leading', 'news-analyst', 'premarket-evidence-watchdog', 'morning-setup']) {
    assert.ok(schedulerManifestJobs().some(job => job.task === task), `${task} must remain scheduled`)
    assert.ok(getSchedulerDependencySpec(task), `${task} must retain its evidence contract`)
  }
})
