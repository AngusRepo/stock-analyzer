import { Hono } from 'hono'
import { getBearerToken, hasServiceToken, requireAdminOrServiceToken, verifyJWT } from '../lib/auth'
import type { Bindings, Variables } from '../types'

// Ops todo kanban (/todo). Reads and writes OPS_DB directly; every write lands in the same
// batch as its todo_card_events row. A 'ready' card (done, awaiting release) must carry a
// release date and at least one PR — the route rejects it first, the table CHECK backs it up.
export const todoBoardRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

export const TODO_LANES = ['todo', 'doing', 'ready', 'live'] as const
export type TodoLane = typeof TODO_LANES[number]
export const TODO_READY_ERROR = 'todo_ready_requires_release_date_and_prs'

export type TodoPr = { number: number; title: string; summary: string }

const LIMITS = {
  id: 64, title: 300, section: 120, owner: 120, content: 20_000, depends_on: 500, source: 500,
  pr_title: 300, pr_summary: 4_000, prs: 50,
} as const
const TEXT_FIELDS = ['title', 'section', 'owner', 'content', 'depends_on', 'source'] as const
const DATE_FIELDS = ['deadline', 'release_date'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]*$/

type CardRow = {
  id: string; title: string; lane: TodoLane; position: number; section: string | null; owner: string | null
  deadline: string | null; release_date: string | null; prs_json: string; content: string | null
  depends_on: string | null; source: string | null; archived: number
  created_at: string; updated_at: string; updated_by: string | null
}
type CardFields = Partial<{
  title: string; lane: TodoLane; position: number; section: string | null; owner: string | null
  deadline: string | null; release_date: string | null; prs: TodoPr[]; content: string | null
  depends_on: string | null; source: string | null
}>

class ValidationError extends Error {}

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | null | undefined {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new ValidationError(`${key}_must_be_string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ValidationError(`${key}_too_long`)
  return trimmed === '' ? null : trimmed
}

function parsePrs(value: unknown): TodoPr[] {
  if (!Array.isArray(value)) throw new ValidationError('prs_must_be_array')
  if (value.length > LIMITS.prs) throw new ValidationError('prs_too_many')
  const prs = value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ValidationError(`prs_${index}_invalid`)
    const pr = item as Record<string, unknown>
    if (!Number.isInteger(pr.number) || (pr.number as number) <= 0) throw new ValidationError(`prs_${index}_number_invalid`)
    if (typeof pr.title !== 'string' || pr.title.trim() === '' || pr.title.length > LIMITS.pr_title) {
      throw new ValidationError(`prs_${index}_title_invalid`)
    }
    if (typeof pr.summary !== 'string' || pr.summary.length > LIMITS.pr_summary) {
      throw new ValidationError(`prs_${index}_summary_invalid`)
    }
    return { number: pr.number as number, title: pr.title.trim(), summary: pr.summary.trim() }
  })
  const numbers = new Set(prs.map((pr) => pr.number))
  if (numbers.size !== prs.length) throw new ValidationError('prs_duplicate_number')
  return prs
}

function parseFields(body: Record<string, unknown>, creating: boolean): CardFields {
  const fields: CardFields = {}
  for (const key of TEXT_FIELDS) {
    const value = optionalText(body, key, LIMITS[key])
    if (value !== undefined) (fields as any)[key] = value
  }
  if (creating || 'title' in body) {
    if (!fields.title) throw new ValidationError('title_required')
  }
  for (const key of DATE_FIELDS) {
    if (!(key in body)) continue
    const value = body[key]
    if (value === null || value === '') { fields[key] = null; continue }
    if (typeof value !== 'string' || !validDate(value.trim())) throw new ValidationError(`${key}_must_be_yyyy_mm_dd`)
    fields[key] = value.trim()
  }
  if ('lane' in body || creating) {
    const lane = body.lane ?? 'todo'
    if (typeof lane !== 'string' || !(TODO_LANES as readonly string[]).includes(lane)) throw new ValidationError('lane_invalid')
    fields.lane = lane as TodoLane
  }
  if ('position' in body) {
    const position = body.position
    if (typeof position !== 'number' || !Number.isFinite(position)) throw new ValidationError('position_must_be_number')
    fields.position = position
  }
  if ('prs' in body) fields.prs = parsePrs(body.prs)
  return fields
}

function readyViolation(lane: TodoLane, releaseDate: string | null | undefined, prs: TodoPr[]): boolean {
  return lane === 'ready' && (!releaseDate || releaseDate.trim() === '' || prs.length === 0)
}

function toCard(row: CardRow) {
  let prs: TodoPr[] = []
  try {
    const parsed = JSON.parse(row.prs_json)
    if (Array.isArray(parsed)) prs = parsed
  } catch { /* table CHECK keeps prs_json valid; tolerate a hand-edited row */ }
  const { prs_json: _ignored, ...rest } = row
  return { ...rest, archived: Boolean(row.archived), prs }
}

function opsDb(c: { env: Bindings }): D1Database | null {
  return c.env.OPS_DB ?? null
}

// requireAdminOrServiceToken does not set userEmail, so resolve the caller from the same token:
// service token -> 'service', admin JWT -> its email. Call only after the auth check passed.
async function actorOf(c: any): Promise<string> {
  const token = getBearerToken(c.req.header('Authorization'))
  if (!token) {
    const email = c.get('userEmail')
    return typeof email === 'string' && email.trim() ? email.trim() : 'service'
  }
  if (hasServiceToken(token, c.env.STOCKVISION_AUTH_TOKEN, c.env.STOCKVISION_AUTH_TOKEN_PREVIOUS)) return 'service'
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (payload?.role === 'service') return 'service'
  const email = typeof payload?.email === 'string' ? payload.email.trim() : ''
  if (email) return email.slice(0, 200)
  const sub = payload?.sub
  return typeof sub === 'string' || typeof sub === 'number' ? `user:${sub}` : 'service'
}

function isCheckViolation(error: unknown): boolean {
  return /CHECK constraint failed/i.test(String((error as any)?.message ?? error))
}

async function readJson(c: any): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function eventStatement(db: D1Database, cardId: string, action: string, fromLane: string | null, toLane: string | null,
  actor: string, detail: unknown) {
  return db.prepare(
    'INSERT INTO todo_card_events(card_id,action,from_lane,to_lane,actor,detail_json) VALUES(?,?,?,?,?,?)',
  ).bind(cardId, action, fromLane, toLane, actor, JSON.stringify(detail ?? {}))
}

async function loadCard(db: D1Database, id: string): Promise<CardRow | null> {
  return await db.prepare('SELECT * FROM todo_cards WHERE id = ?').bind(id).first<CardRow>() ?? null
}

todoBoardRoutes.get('/api/admin/todo/cards', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  const db = opsDb(c)
  if (!db) return c.json({ error: 'ops_db_unavailable' }, 503)
  const includeArchived = c.req.query('include_archived') === '1'
  const rows = await db.prepare(
    `SELECT * FROM todo_cards ${includeArchived ? '' : 'WHERE archived = 0 '}`
    + `ORDER BY CASE lane WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'ready' THEN 2 WHEN 'live' THEN 3 ELSE 4 END, position ASC, updated_at DESC`,
  ).all<CardRow>()
  return c.json({ cards: (rows.results ?? []).map(toCard), lanes: TODO_LANES })
})

todoBoardRoutes.post('/api/admin/todo/cards', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  const db = opsDb(c)
  if (!db) return c.json({ error: 'ops_db_unavailable' }, 503)
  const body = await readJson(c)
  if (!body) return c.json({ error: 'invalid_json_body' }, 400)
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id || id.length > LIMITS.id || !ID_RE.test(id)) return c.json({ error: 'id_invalid' }, 400)
  let fields: CardFields
  try { fields = parseFields(body, true) } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400)
    throw error
  }
  const lane = fields.lane ?? 'todo'
  const prs = fields.prs ?? []
  if (readyViolation(lane, fields.release_date, prs)) return c.json({ error: TODO_READY_ERROR }, 400)
  if (await loadCard(db, id)) return c.json({ error: 'todo_card_id_exists', id }, 409)
  const actor = await actorOf(c)
  const position = fields.position ?? Date.now()
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO todo_cards(id,title,lane,position,section,owner,deadline,release_date,prs_json,content,depends_on,source,archived,updated_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      ).bind(id, fields.title!, lane, position, fields.section ?? null, fields.owner ?? null, fields.deadline ?? null,
        fields.release_date ?? null, JSON.stringify(prs), fields.content ?? null, fields.depends_on ?? null,
        fields.source ?? null, actor),
      eventStatement(db, id, 'create', null, lane, actor, { fields: Object.keys(fields) }),
    ])
  } catch (error) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(error))) return c.json({ error: 'todo_card_id_exists', id }, 409)
    if (isCheckViolation(error)) return c.json({ error: TODO_READY_ERROR }, 400)
    throw error
  }
  const created = await loadCard(db, id)
  return c.json({ card: created ? toCard(created) : null }, 201)
})

todoBoardRoutes.patch('/api/admin/todo/cards/:id', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  const db = opsDb(c)
  if (!db) return c.json({ error: 'ops_db_unavailable' }, 503)
  const id = c.req.param('id')
  const body = await readJson(c)
  if (!body) return c.json({ error: 'invalid_json_body' }, 400)
  let fields: CardFields
  try { fields = parseFields(body, false) } catch (error) {
    if (error instanceof ValidationError) return c.json({ error: error.message }, 400)
    throw error
  }
  const current = await loadCard(db, id)
  if (!current) return c.json({ error: 'todo_card_not_found', id }, 404)
  if (current.archived) return c.json({ error: 'todo_card_archived', id }, 409)
  const before = toCard(current)
  const lane = fields.lane ?? current.lane
  const releaseDate = fields.release_date !== undefined ? fields.release_date : current.release_date
  const prs = fields.prs ?? before.prs
  if (readyViolation(lane, releaseDate, prs)) return c.json({ error: TODO_READY_ERROR }, 400)
  const changed = Object.keys(fields)
  if (changed.length === 0) return c.json({ card: before })
  const assignments: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'prs') { assignments.push('prs_json = ?'); values.push(JSON.stringify(value)) }
    else { assignments.push(`${key} = ?`); values.push(value) }
  }
  const actor = await actorOf(c)
  const action = fields.lane && fields.lane !== current.lane ? 'move' : 'update'
  try {
    await db.batch([
      db.prepare(`UPDATE todo_cards SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
        .bind(...values, actor, id),
      eventStatement(db, id, action, current.lane, lane, actor, { fields: changed }),
    ])
  } catch (error) {
    if (isCheckViolation(error)) return c.json({ error: TODO_READY_ERROR }, 400)
    throw error
  }
  const updated = await loadCard(db, id)
  return c.json({ card: updated ? toCard(updated) : null })
})

todoBoardRoutes.post('/api/admin/todo/cards/:id/archive', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  const db = opsDb(c)
  if (!db) return c.json({ error: 'ops_db_unavailable' }, 503)
  const id = c.req.param('id')
  const body = await readJson(c)
  const archived = body?.archived === false ? 0 : 1
  const current = await loadCard(db, id)
  if (!current) return c.json({ error: 'todo_card_not_found', id }, 404)
  const actor = await actorOf(c)
  await db.batch([
    db.prepare('UPDATE todo_cards SET archived = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?')
      .bind(archived, actor, id),
    eventStatement(db, id, archived ? 'archive' : 'unarchive', current.lane, current.lane, actor, {}),
  ])
  const updated = await loadCard(db, id)
  return c.json({ card: updated ? toCard(updated) : null })
})
