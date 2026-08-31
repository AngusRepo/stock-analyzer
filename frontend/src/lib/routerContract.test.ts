import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
const appShell = fs.readFileSync(path.join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const routeModules = fs.readFileSync(path.join(root, 'src', 'lib', 'routeModules.ts'), 'utf8')

assert(!app.includes('path="/dashboard"'), '/dashboard must not be a frontend route')
assert(!app.includes('path="/home"'), '/home must not be a frontend route')
assert(app.includes('<Route component={NotFound} />'), 'Unknown URLs must render the 404 page')
assert(!routeModules.includes("href === '/dashboard'"), '/dashboard must not preload the homepage')
assert(!routeModules.includes("href === '/home'"), '/home must not preload the homepage')
assert(!appShell.includes("currentPath === '/dashboard'"), '/dashboard must not activate the homepage nav')
assert(!appShell.includes("currentPath === '/home'"), '/home must not activate the homepage nav')

console.log('routerContract: OK')
