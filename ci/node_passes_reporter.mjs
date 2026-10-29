// node --test reporter: the ids of passed (not skipped) tests, same format as node_failures_reporter.mjs.
import { testIds } from './node_failures_reporter.mjs'

export default testIds('test:pass')
