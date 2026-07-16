import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const apiSource = readFileSync(resolve(process.cwd(), 'src/lib/api.ts'), 'utf8')
const workerAuthSource = readFileSync(resolve(process.cwd(), '../worker/src/routes/auth.ts'), 'utf8')
const authPolicySource = readFileSync(resolve(process.cwd(), '../worker/src/lib/auth.ts'), 'utf8')

assert.doesNotMatch(apiSource, /sv_token/)
assert.doesNotMatch(apiSource, /Authorization.*Bearer/)
assert.match(apiSource, /credentials: 'include'/)
assert.match(apiSource, /X-CSRF-Token/)
assert.match(workerAuthSource, /httpOnly: true/)
assert.match(workerAuthSource, /CSRF_COOKIE_NAME/)
assert.match(authPolicySource, /csrfErrorForCookieMutation/)
