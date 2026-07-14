import { ZIP_LIMITS } from './config'

export interface ZipEntryInput { name: string; data: Uint8Array }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function set16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true) }
function set32(view: DataView, offset: number, value: number) { view.setUint32(offset, value >>> 0, true) }
function get16(view: DataView, offset: number) { return view.getUint16(offset, true) }
function get32(view: DataView, offset: number) { return view.getUint32(offset, true) }

export function validateZipPath(name: string): void {
  if (!name || name.length > ZIP_LIMITS.maxPathLength) throw new Error('zip_invalid_path_length')
  if (name.includes('\0') || name.includes('\\')) throw new Error('zip_invalid_path_separator')
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('zip_absolute_path_rejected')
  const parts = name.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('zip_path_traversal_rejected')
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

export function createStoredZip(entries: ZipEntryInput[]): Uint8Array {
  if (!entries.length || entries.length > ZIP_LIMITS.maxEntries) throw new Error('zip_entry_count_invalid')
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set<string>()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  let total = 0
  for (const entry of sorted) {
    validateZipPath(entry.name)
    if (seen.has(entry.name)) throw new Error('zip_duplicate_entry')
    seen.add(entry.name)
    if (entry.data.byteLength > ZIP_LIMITS.maxEntryBytes) throw new Error('zip_entry_too_large')
    total += entry.data.byteLength
    if (total > ZIP_LIMITS.maxTotalUncompressedBytes) throw new Error('zip_total_too_large')
    const name = new TextEncoder().encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    set32(lv, 0, 0x04034b50); set16(lv, 4, 20); set16(lv, 6, 0x0800); set16(lv, 8, 0)
    set16(lv, 10, 0); set16(lv, 12, 0); set32(lv, 14, crc)
    set32(lv, 18, entry.data.byteLength); set32(lv, 22, entry.data.byteLength)
    set16(lv, 26, name.length); set16(lv, 28, 0); local.set(name, 30)
    locals.push(local, entry.data)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    set32(cv, 0, 0x02014b50); set16(cv, 4, 20); set16(cv, 6, 20); set16(cv, 8, 0x0800)
    set16(cv, 10, 0); set16(cv, 12, 0); set16(cv, 14, 0); set32(cv, 16, crc)
    set32(cv, 20, entry.data.byteLength); set32(cv, 24, entry.data.byteLength)
    set16(cv, 28, name.length); set16(cv, 30, 0); set16(cv, 32, 0); set16(cv, 34, 0)
    set16(cv, 36, 0); set32(cv, 38, 0); set32(cv, 42, offset); central.set(name, 46)
    centrals.push(central)
    offset += local.byteLength + entry.data.byteLength
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  set32(ev, 0, 0x06054b50); set16(ev, 4, 0); set16(ev, 6, 0)
  set16(ev, 8, sorted.length); set16(ev, 10, sorted.length)
  set32(ev, 12, centralSize); set32(ev, 16, centralOffset); set16(ev, 20, 0)
  return concat([...locals, ...centrals, end])
}

export function parseStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!bytes.byteLength || bytes.byteLength > ZIP_LIMITS.maxUploadBytes) throw new Error('zip_upload_size_invalid')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let endOffset = -1
  for (let i = Math.max(0, bytes.byteLength - 65_557); i <= bytes.byteLength - 22; i += 1) {
    if (get32(view, i) === 0x06054b50) endOffset = i
  }
  if (endOffset < 0) throw new Error('zip_end_record_missing')
  const disk = get16(view, endOffset + 4)
  const centralDisk = get16(view, endOffset + 6)
  const count = get16(view, endOffset + 10)
  const centralSize = get32(view, endOffset + 12)
  const centralOffset = get32(view, endOffset + 16)
  if (disk !== 0 || centralDisk !== 0) throw new Error('zip_multidisk_rejected')
  if (!count || count > ZIP_LIMITS.maxEntries) throw new Error('zip_entry_count_invalid')
  if (centralOffset + centralSize > endOffset) throw new Error('zip_central_directory_invalid')
  const output = new Map<string, Uint8Array>()
  let cursor = centralOffset
  let total = 0
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > bytes.byteLength || get32(view, cursor) !== 0x02014b50) throw new Error('zip_central_entry_invalid')
    const flags = get16(view, cursor + 8)
    const method = get16(view, cursor + 10)
    const expectedCrc = get32(view, cursor + 16)
    const compressedSize = get32(view, cursor + 20)
    const uncompressedSize = get32(view, cursor + 24)
    const nameLength = get16(view, cursor + 28)
    const extraLength = get16(view, cursor + 30)
    const commentLength = get16(view, cursor + 32)
    const localOffset = get32(view, cursor + 42)
    if ((flags & 1) !== 0) throw new Error('zip_encrypted_entry_rejected')
    if (method !== 0) throw new Error('zip_unsupported_compression')
    if (compressedSize !== uncompressedSize) throw new Error('zip_stored_size_mismatch')
    if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new Error('zip_entry_too_large')
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.byteLength) throw new Error('zip_entry_name_invalid')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(nameStart, nameEnd))
    validateZipPath(name)
    if (output.has(name)) throw new Error('zip_duplicate_entry')
    if (localOffset + 30 > bytes.byteLength || get32(view, localOffset) !== 0x04034b50) throw new Error('zip_local_entry_invalid')
    const localFlags = get16(view, localOffset + 6)
    const localMethod = get16(view, localOffset + 8)
    const localCrc = get32(view, localOffset + 14)
    const localCompressedSize = get32(view, localOffset + 18)
    const localUncompressedSize = get32(view, localOffset + 22)
    const localNameLength = get16(view, localOffset + 26)
    const localExtraLength = get16(view, localOffset + 28)
    const localNameStart = localOffset + 30
    const localNameEnd = localNameStart + localNameLength
    if (localNameEnd > bytes.byteLength) throw new Error('zip_local_name_invalid')
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(localNameStart, localNameEnd))
    if (localName !== name || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      throw new Error('zip_local_central_mismatch')
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.byteLength) throw new Error('zip_entry_body_invalid')
    const data = bytes.slice(dataStart, dataEnd)
    if (crc32(data) !== expectedCrc) throw new Error('zip_crc_mismatch')
    total += data.byteLength
    if (total > ZIP_LIMITS.maxTotalUncompressedBytes) throw new Error('zip_total_too_large')
    output.set(name, data)
    cursor = nameEnd + extraLength + commentLength
  }
  return output
}

export function jsonZipEntry(name: string, value: unknown): ZipEntryInput {
  return { name, data: new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n') }
}
