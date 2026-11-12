import assert from 'node:assert/strict'
import {postcloseDispatchLabel, withPostcloseDispatchWait} from '../components/observability/postcloseDispatchWait'
import type {SchedulerJob} from './api'
const root={id:'evening-chain',lastStatus:'waiting',summary:'pipeline serving published; research waits for the after-close dispatch at 2026-11-02 14:20 run_id=r'} as SchedulerJob
assert.equal(postcloseDispatchLabel(root),'11/2 14:20')
assert.equal(postcloseDispatchLabel({...root,lastStatus:'running'}),null,'after the dispatch the stages wait on each other, not on it')
assert.equal(postcloseDispatchLabel({...root,summary:'pipeline serving published; research waits for the after-close dispatch run_id=r'}),null)
const verify={id:'verify-v2',lastStatus:'waiting',summary:'',lastRunAt:null} as SchedulerJob
assert.equal(withPostcloseDispatchWait(verify,'11/2 14:20').summary,'等待 11/2 14:20 收盤後 research dispatch')
const own={...verify,summary:'Serving published; research waits'} as SchedulerJob
assert.strictEqual(withPostcloseDispatchWait(own,'11/2 14:20'),own,'a stage with its own summary keeps it')
assert.strictEqual(withPostcloseDispatchWait(verify,null),verify)
console.log('postcloseDispatchWait ok')
