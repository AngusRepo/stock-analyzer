declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exitCode?: number
  cwd(): string
  exit(code?: number): never
}
