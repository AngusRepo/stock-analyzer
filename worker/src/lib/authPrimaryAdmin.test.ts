import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrimaryAdmin } from './auth'

test('isPrimaryAdmin matches the ADMIN_EMAIL admin case-insensitively', () => {
  assert.equal(isPrimaryAdmin({ email: ' Owner@Example.com ', role: 'admin' }, 'owner@example.com'), true)
})

test('isPrimaryAdmin rejects other admins, non-admins, and an unset secret', () => {
  assert.equal(isPrimaryAdmin({ email: 'other@example.com', role: 'admin' }, 'owner@example.com'), false)
  assert.equal(isPrimaryAdmin({ email: 'owner@example.com', role: 'user' }, 'owner@example.com'), false)
  assert.equal(isPrimaryAdmin({ email: 'owner@example.com', role: 'admin' }, undefined), false)
  assert.equal(isPrimaryAdmin({ email: 'owner@example.com', role: 'admin' }, '  '), false)
  assert.equal(isPrimaryAdmin(null, 'owner@example.com'), false)
})

test('/auth/me returns the server-side primary admin flag', () => {
  const routes = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'auth.ts'), 'utf8')
  assert.ok(routes.includes('is_primary_admin: isPrimaryAdmin(user, c.env.ADMIN_EMAIL)'), '/auth/me must expose is_primary_admin so the bundle need not carry the email')
})
