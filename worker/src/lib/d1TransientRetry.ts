export function isTransientD1Reset(error: unknown): boolean {
  const message = String(error)
  return /D1_ERROR|storage operation exceeded timeout|CPU time limit|object .* reset|connection reset|temporar/i.test(message)
    || /D1 request failed:\s*HTTP\s*(?:429|5\d\d)/i.test(message)
    || /["']?code["']?\s*:\s*7010\b/i.test(message)
}

export function tagD1StageError(
  stage: string,
  queryFamily: string,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('d1_stage=')) return error instanceof Error ? error : new Error(message)
  return new Error(`d1_stage=${stage};query_family=${queryFamily};cause=${message}`, {
    cause: error,
  })
}

export async function withD1ReadRetry<T>(
  stage: string,
  queryFamily: string,
  operation: () => Promise<T>,
  attempts = 2,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientD1Reset(error) || attempt >= attempts) {
        throw tagD1StageError(stage, queryFamily, error)
      }
      const delayMs = 150 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100)
      console.warn(
        `[D1ReadRetry] stage=${stage} query_family=${queryFamily} ` +
        `attempt=${attempt}/${attempts} retry_ms=${delayMs}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw tagD1StageError(stage, queryFamily, lastError)
}
