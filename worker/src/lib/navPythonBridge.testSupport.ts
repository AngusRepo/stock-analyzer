// Test-only: one long-lived `nav_l3_opb_bridge.py --serve` per test instead of a fresh
// interpreter per read (27 reads cost 37 s of the 70 s EV handoff test, mostly start-up and
// imports). A worker thread owns the child; the caller blocks on Atomics.wait, so reads stay
// synchronous and `assert.throws(() => bridge(...))` keeps working.
import path from 'node:path'
import { once } from 'node:events'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'

// Every reply carries its request id and bumps the shared counter after it is queued on the port.
// Once the child is gone, pending and later requests get an error reply at once.
const OWNER = `
const { workerData } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const { flag, port, python, cwd } = workerData
const child = spawn(python, ['tests/nav_l3_opb_bridge.py', '--serve'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] })
const pending = []
let buffer = '', dead = null
const reply = line => { port.postMessage(line); Atomics.add(flag, 0, 1); Atomics.notify(flag, 0) }
const fail = reason => {
  dead = dead ?? reason
  for (const id of pending.splice(0)) reply(JSON.stringify({ id, error: dead }))
}
child.on('error', error => fail('nav python bridge failed: ' + error.message))
child.stdin.on('error', error => fail('nav python bridge stdin failed: ' + error.message))
child.on('exit', code => fail('nav python bridge exited ' + code))
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    pending.shift()
    reply(line)
  }
})
port.on('message', message => {
  if (message === null) {
    if (dead) process.exit(0)
    child.once('exit', () => process.exit(0))
    return void child.kill()
  }
  if (dead) return reply(JSON.stringify({ id: message.id, error: dead }))
  pending.push(message.id)
  child.stdin.write(JSON.stringify(message) + '\\n')
})
`

export function startNavPythonBridge(python: string, t: { after: (fn: () => void | Promise<void>) => void }) {
  const flag = new Int32Array(new SharedArrayBuffer(4))
  const { port1, port2 } = new MessageChannel()
  const owner = new Worker(OWNER, { eval: true, workerData: { flag, port: port2, python, cwd: path.resolve('../ml-controller') },
    transferList: [port2] })
  t.after(async () => {
    port1.postMessage(null)
    port1.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([once(owner, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 10000) })])
    clearTimeout(timer)
    await owner.terminate()
  })
  let next = 0
  return (request: Record<string, unknown>) => {
    const id = ++next
    port1.postMessage({ id, request })
    // performance.now: the tests replace Date with a fixed clock.
    const deadline = performance.now() + 60000
    for (;;) {
      const seen = Atomics.load(flag, 0)
      for (let message; (message = receiveMessageOnPort(port1));) {
        const reply = JSON.parse(message.message)
        if (reply.id !== id) continue // late reply to a request that already timed out
        if ('error' in reply) throw new Error(reply.error)
        return reply.result
      }
      const left = deadline - performance.now()
      if (left <= 0 || Atomics.wait(flag, 0, seen, left) === 'timed-out') throw new Error('nav_python_bridge_timeout')
    }
  }
}
