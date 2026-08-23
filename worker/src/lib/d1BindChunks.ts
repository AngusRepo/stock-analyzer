/** Keep D1 IN-list queries below the 100-bound-parameter ceiling. */
export const D1_SAFE_IN_CHUNK_SIZE = 36

export function d1SafeInChunks<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += D1_SAFE_IN_CHUNK_SIZE) {
    chunks.push(values.slice(offset, offset + D1_SAFE_IN_CHUNK_SIZE))
  }
  return chunks
}
