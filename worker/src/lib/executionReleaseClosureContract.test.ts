import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = fs.existsSync(path.join(process.cwd(), 'worker'))
  ? process.cwd()
  : path.join(process.cwd(), '..')

function read(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf8')
}

const schedulerManifest = JSON.parse(read('infra/gcp-scheduler-jobs.json'))
const intradayCheckJobs = schedulerManifest.jobs.filter((job: any) => job.task === 'intraday-check')
const controllerRouter = read('ml-controller/routers/finlab.py')
const workerIndex = read('worker/src/index.ts')
const adminReadRoutes = read('worker/src/routes/adminReadRoutes.ts')

assert(
  intradayCheckJobs.length === 2 &&
    intradayCheckJobs.every((job: any) => job.baseUrlEnv === 'ML_CONTROLLER_URL') &&
    intradayCheckJobs.every((job: any) => job.path === '/finlab/execution/production-simulated-loop'),
  'intraday-check schedulers must be split jobs targeting ML Controller production-simulated loop route',
)
assert(
  controllerRouter.includes('@router.post("/execution/production-simulated-loop")'),
  'ml-controller router must expose the exact route targeted by Scheduler',
)
assert(
  workerIndex.includes("import { finlabExecutionLoopRoutes } from './routes/finlabExecutionLoopRoutes'") &&
    workerIndex.includes("app.route('/',                    finlabExecutionLoopRoutes)"),
  'Worker must mount the internal execution loop endpoint before production deploy',
)
assert(
  adminReadRoutes.includes("adminReadRoutes.get('/api/admin/execution/pre-pilot-evidence'") &&
    adminReadRoutes.includes('buildExecutionPrePilotEvidenceReport'),
  'Worker must expose the pre-pilot evidence read endpoint before production deploy',
)
