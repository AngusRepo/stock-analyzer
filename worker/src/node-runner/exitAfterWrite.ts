import * as process from 'node:process'

// process.exit() drops stdout still queued for a POSIX pipe, so a large final
// protocol line reached the parent truncated. Exit only once the line is flushed.
export function writeLineThenExit(value: unknown, code: number): void {
  process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(code))
}
