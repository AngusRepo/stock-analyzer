import * as process from 'node:process'

export function writeLineThenExit(value: unknown, code: number): void {
  process.stdout.write(JSON.stringify(value) + '\n')
  process.exit(code)
}
