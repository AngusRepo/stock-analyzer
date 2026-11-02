import { useMemo, useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import AppShell from '@/components/AppShell'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  WorkstationPageTitle,
  WorkstationPanel,
  WorkstationPill,
  type WorkstationTone,
} from '@/components/workstation/WorkstationChrome'
import { apiRequest } from '@/lib/apiClient'

type Lane = 'todo' | 'doing' | 'ready' | 'live'
type TodoPr = { number: number; title: string; summary: string }
type TodoCard = {
  id: string
  title: string
  lane: Lane
  position: number
  section: string | null
  owner: string | null
  deadline: string | null
  release_date: string | null
  prs: TodoPr[]
  content: string | null
  depends_on: string | null
  source: string | null
  archived: boolean
  created_at: string
  updated_at: string
  updated_by: string | null
}
type CardsResponse = { cards: TodoCard[] }
type CardResponse = { card: TodoCard | null }
type CardPatch = Partial<Omit<TodoCard, 'id' | 'archived' | 'created_at' | 'updated_at' | 'updated_by'>>

const LANES: Array<{ id: Lane; label: string; tone: WorkstationTone }> = [
  { id: 'todo', label: '待辦', tone: 'neutral' },
  { id: 'doing', label: '進行中', tone: 'info' },
  { id: 'ready', label: '已完成待上線', tone: 'warn' },
  { id: 'live', label: '已上線', tone: 'ok' },
]
const READY_ERROR_CODE = 'todo_ready_requires_release_date_and_prs'
const READY_MESSAGE = '已完成待上線卡必須有預計上線日與至少一個 PR'
const PR_URL = 'https://github.com/AngusRepo/stock-analyzer/pull/'
const CARDS_PATH = '/admin/todo/cards'

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(READY_ERROR_CODE) ? READY_MESSAGE : message
}

function missingReadyFields(lane: Lane, releaseDate: string | null | undefined, prs: TodoPr[]) {
  return lane === 'ready' && (!releaseDate || !releaseDate.trim() || prs.length === 0)
}

type Draft = {
  id: string
  title: string
  lane: Lane
  section: string
  owner: string
  deadline: string
  release_date: string
  content: string
  depends_on: string
  source: string
  prs: Array<{ number: string; title: string; summary: string }>
}

function draftFromCard(card: TodoCard | null, lane: Lane = 'todo'): Draft {
  return {
    id: card?.id ?? '',
    title: card?.title ?? '',
    lane,
    section: card?.section ?? '',
    owner: card?.owner ?? '',
    deadline: card?.deadline ?? '',
    release_date: card?.release_date ?? '',
    content: card?.content ?? '',
    depends_on: card?.depends_on ?? '',
    source: card?.source ?? '',
    prs: (card?.prs ?? []).map((pr) => ({ number: String(pr.number), title: pr.title, summary: pr.summary })),
  }
}

function draftPayload(draft: Draft): { fields: CardPatch; error: string | null } {
  const prs: TodoPr[] = []
  for (const [index, row] of draft.prs.entries()) {
    if (!row.number.trim() && !row.title.trim() && !row.summary.trim()) continue
    const number = Number(row.number)
    if (!Number.isInteger(number) || number <= 0) return { fields: {}, error: `第 ${index + 1} 個 PR 編號必須是正整數` }
    if (!row.title.trim()) return { fields: {}, error: `第 ${index + 1} 個 PR 缺標題` }
    if (prs.some((pr) => pr.number === number)) return { fields: {}, error: `PR #${number} 重複` }
    prs.push({ number, title: row.title.trim(), summary: row.summary.trim() })
  }
  if (!draft.title.trim()) return { fields: {}, error: '標題必填' }
  const text = (value: string) => (value.trim() ? value.trim() : null)
  const fields: CardPatch = {
    title: draft.title.trim(),
    lane: draft.lane,
    section: text(draft.section),
    owner: text(draft.owner),
    deadline: text(draft.deadline),
    release_date: text(draft.release_date),
    content: text(draft.content),
    depends_on: text(draft.depends_on),
    source: text(draft.source),
    prs,
  }
  if (missingReadyFields(draft.lane, fields.release_date, prs)) return { fields, error: READY_MESSAGE }
  return { fields, error: null }
}

function changedFields(original: TodoCard | null, fields: CardPatch): CardPatch {
  if (!original) return fields
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    const before = original[key as keyof TodoCard]
    if (JSON.stringify(value ?? null) !== JSON.stringify(before ?? null)) changed[key] = value
  }
  return changed as CardPatch
}

const inputClass = 'w-full min-w-0 rounded-lg border border-[#2b3a49] bg-[#05070c] px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-[#d6a85f]/60'
const labelClass = 'block space-y-1 text-[11px] text-[#9badbf]'

function TodoCardView({
  card,
  onMove,
  onEdit,
  onArchive,
}: {
  card: TodoCard
  onMove: (card: TodoCard, lane: Lane) => void
  onEdit: (card: TodoCard) => void
  onArchive: (card: TodoCard, archived: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const content = card.content ?? ''
  const long = content.length > 160
  const showRelease = card.lane === 'ready' || card.lane === 'live'

  return (
    <article
      draggable={!card.archived}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      className={`min-w-0 space-y-2 rounded-xl border border-[#263247] bg-[#05070c] p-3 ${card.archived ? 'opacity-60' : 'cursor-grab active:cursor-grabbing'}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="sv-num break-all text-[11px] text-[#d6a85f]">{card.id}</p>
          <h3 className="break-words text-sm font-semibold text-slate-100">{card.title}</h3>
        </div>
        <div className="flex shrink-0 gap-1">
          {!card.archived && (
            <button type="button" aria-label={`編輯 ${card.id}`} onClick={() => onEdit(card)} className="rounded-md border border-[#2b3a49] p-1 text-slate-300 hover:text-[#f1c16f]">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={card.archived ? `取消封存 ${card.id}` : `封存 ${card.id}`}
            onClick={() => onArchive(card, !card.archived)}
            className="rounded-md border border-[#2b3a49] p-1 text-slate-300 hover:text-[#f1c16f]"
          >
            {card.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap gap-1.5 text-[11px] [&>span]:max-w-full [&>span]:break-all">
        {card.archived && <WorkstationPill tone="neutral">已封存</WorkstationPill>}
        {card.section && <WorkstationPill tone="info">{card.section}</WorkstationPill>}
        {card.owner && <WorkstationPill tone="neutral">owner {card.owner}</WorkstationPill>}
        {card.deadline && <WorkstationPill tone="warn">deadline {card.deadline}</WorkstationPill>}
      </div>

      {content && (
        <div className="text-xs leading-5 text-[#a8b6c5]">
          <p className="whitespace-pre-wrap break-words">{expanded || !long ? content : `${content.slice(0, 160)}…`}</p>
          {long && (
            <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-[11px] text-[#f1c16f]">
              {expanded ? '收合' : '展開全文'}
            </button>
          )}
        </div>
      )}

      {card.depends_on && <p className="break-words text-[11px] text-[#70809b]">依賴：{card.depends_on}</p>}

      {showRelease && (
        <div className="space-y-1.5 rounded-lg border border-[#2b3a49] bg-[#0b1118] p-2">
          <p className="sv-num text-[11px] text-[#ffd87f]">預計上線日：{card.release_date ?? '未填'}</p>
          {card.prs.length === 0 && <p className="text-[11px] text-rose-300">尚無 PR</p>}
          {card.prs.map((pr) => (
            <div key={pr.number} className="min-w-0 text-xs">
              <a href={`${PR_URL}${pr.number}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[#a5e7ff] hover:underline">
                <span className="sv-num shrink-0">#{pr.number}</span>
                <span className="min-w-0 break-words">{pr.title}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              {pr.summary && <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-[#9badbf]">{pr.summary}</p>}
            </div>
          ))}
        </div>
      )}

      {!card.archived && (
        <label className="flex items-center gap-2 text-[11px] text-[#9badbf]">
          移到…
          <select
            value={card.lane}
            onChange={(event) => onMove(card, event.target.value as Lane)}
            className="min-w-0 flex-1 rounded-md border border-[#2b3a49] bg-[#05070c] px-2 py-1 text-xs text-slate-100"
          >
            {LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
          </select>
        </label>
      )}
    </article>
  )
}

function CardEditor({
  open,
  creating,
  draft,
  setDraft,
  error,
  saving,
  onClose,
  onSave,
}: {
  open: boolean
  creating: boolean
  draft: Draft
  setDraft: (next: Draft) => void
  error: string | null
  saving: boolean
  onClose: () => void
  onSave: () => void
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value })
  const setPr = (index: number, key: 'number' | 'title' | 'summary', value: string) =>
    set('prs', draft.prs.map((row, i) => (i === index ? { ...row, [key]: value } : row)))

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#2b3a49] bg-[#0f151d] text-slate-100 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{creating ? '新增卡片' : `編輯 ${draft.id}`}</DialogTitle>
          <DialogDescription className="text-[#9badbf]">已完成待上線卡必須填預計上線日與至少一個 PR。</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {creating && (
            <label className={labelClass}>ID
              <input className={inputClass} value={draft.id} maxLength={64} onChange={(e) => set('id', e.target.value)} placeholder="K15、FG-02、D9／D-5" />
            </label>
          )}
          <label className={`${labelClass} ${creating ? '' : 'sm:col-span-2'}`}>標題
            <input className={inputClass} value={draft.title} maxLength={300} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className={labelClass}>欄位
            <select className={inputClass} value={draft.lane} onChange={(e) => set('lane', e.target.value as Lane)}>
              {LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
            </select>
          </label>
          <label className={labelClass}>Section
            <input className={inputClass} value={draft.section} maxLength={120} onChange={(e) => set('section', e.target.value)} />
          </label>
          <label className={labelClass}>Owner
            <input className={inputClass} value={draft.owner} maxLength={120} onChange={(e) => set('owner', e.target.value)} />
          </label>
          <label className={labelClass}>Deadline
            <input className={inputClass} value={draft.deadline} maxLength={120} placeholder="2026-11-05 或 K18-B 後" onChange={(e) => set('deadline', e.target.value)} />
          </label>
          <label className={labelClass}>預計上線日
            <input type="date" className={inputClass} value={draft.release_date} onChange={(e) => set('release_date', e.target.value)} />
          </label>
          <label className={labelClass}>依賴
            <input className={inputClass} value={draft.depends_on} maxLength={500} onChange={(e) => set('depends_on', e.target.value)} />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>來源
            <input className={inputClass} value={draft.source} maxLength={500} onChange={(e) => set('source', e.target.value)} />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>內容
            <textarea className={`${inputClass} min-h-28`} value={draft.content} maxLength={20000} onChange={(e) => set('content', e.target.value)} />
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-[#9badbf]">PR（編號、標題、內容）</p>
            <button
              type="button"
              onClick={() => set('prs', [...draft.prs, { number: '', title: '', summary: '' }])}
              className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 text-[11px] text-[#f1c16f]"
            >
              <Plus className="h-3 w-3" /> 新增 PR
            </button>
          </div>
          {draft.prs.map((row, index) => (
            <div key={index} className="grid grid-cols-[5rem_1fr_auto] gap-2 rounded-lg border border-[#263247] p-2">
              <input className={inputClass} inputMode="numeric" placeholder="#" value={row.number} onChange={(e) => setPr(index, 'number', e.target.value)} />
              <input className={inputClass} placeholder="PR 標題" maxLength={300} value={row.title} onChange={(e) => setPr(index, 'title', e.target.value)} />
              <button
                type="button"
                aria-label="刪除 PR"
                onClick={() => set('prs', draft.prs.filter((_, i) => i !== index))}
                className="row-span-2 self-start rounded-md border border-[#2b3a49] p-1.5 text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <textarea className={`${inputClass} col-span-2 min-h-14`} placeholder="PR 內容" maxLength={4000} value={row.summary} onChange={(e) => setPr(index, 'summary', e.target.value)} />
            </div>
          ))}
        </div>

        {error && <p className="rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-2 text-sm text-rose-200">{error}</p>}

        <DialogFooter>
          <button type="button" onClick={onClose} className="rounded-full border border-[#2b3a49] px-3 py-1.5 text-sm text-slate-300">取消</button>
          <button
            type="button"
            disabled={saving}
            onClick={onSave}
            className="rounded-full border border-[#d6a85f]/50 bg-[#d6a85f]/10 px-3 py-1.5 text-sm text-[#f1c16f] disabled:opacity-50"
          >
            {saving ? '儲存中…' : '儲存'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function TodoBoardPage() {
  const queryClient = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ open: boolean; creating: boolean; original: TodoCard | null; draft: Draft; error: string | null }>({
    open: false, creating: false, original: null, draft: draftFromCard(null), error: null,
  })
  const [dropLane, setDropLane] = useState<Lane | null>(null)
  const queryKey = useMemo(() => ['todo', 'cards', showArchived ? 'all' : 'active'] as const, [showArchived])

  const cardsQuery = useQuery({
    queryKey,
    queryFn: () => apiRequest<CardsResponse>('GET', `${CARDS_PATH}${showArchived ? '?include_archived=1' : ''}`),
  })
  const cards = cardsQuery.data?.cards ?? []

  const applyOptimistic = async (id: string, change: (card: TodoCard) => TodoCard | null) => {
    await queryClient.cancelQueries({ queryKey: ['todo', 'cards'] })
    const previous = queryClient.getQueryData<CardsResponse>(queryKey)
    if (previous) {
      queryClient.setQueryData<CardsResponse>(queryKey, {
        ...previous,
        cards: previous.cards.flatMap((card) => {
          if (card.id !== id) return [card]
          const next = change(card)
          return next ? [next] : []
        }),
      })
    }
    return { previous }
  }
  const rollback = (context: { previous?: CardsResponse } | undefined) => {
    if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
  }
  const settle = () => queryClient.invalidateQueries({ queryKey: ['todo', 'cards'] })

  const patchCard = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: CardPatch }) =>
      apiRequest<CardResponse>('PATCH', `${CARDS_PATH}/${encodeURIComponent(id)}`, fields),
    onMutate: ({ id, fields }) => applyOptimistic(id, (card) => ({ ...card, ...fields })),
    onError: (error, _vars, context) => {
      rollback(context)
      setBoardError(errorText(error))
    },
    onSettled: settle,
  })
  const archiveCard = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiRequest<CardResponse>('POST', `${CARDS_PATH}/${encodeURIComponent(id)}/archive`, { archived }),
    onMutate: ({ id, archived }) => applyOptimistic(id, (card) => (archived && !showArchived ? null : { ...card, archived })),
    onError: (error, _vars, context) => {
      rollback(context)
      setBoardError(errorText(error))
    },
    onSettled: settle,
  })
  const createCard = useMutation({
    mutationFn: (fields: CardPatch & { id: string }) => apiRequest<CardResponse>('POST', CARDS_PATH, fields),
    onSettled: settle,
  })

  const openEditor = (card: TodoCard | null, lane?: Lane, error: string | null = null) =>
    setEditor({ open: true, creating: !card, original: card, draft: draftFromCard(card, lane ?? card?.lane ?? 'todo'), error })

  const moveCard = (card: TodoCard, lane: Lane) => {
    if (lane === card.lane) return
    setBoardError(null)
    if (missingReadyFields(lane, card.release_date, card.prs)) {
      openEditor(card, lane, READY_MESSAGE)
      return
    }
    const lanePositions = cards.filter((item) => item.lane === lane && item.id !== card.id).map((item) => item.position)
    const position = (lanePositions.length ? Math.max(...lanePositions) : 0) + 1
    patchCard.mutate({ id: card.id, fields: { lane, position } })
  }

  const saveEditor = async () => {
    const { fields, error } = draftPayload(editor.draft)
    if (editor.creating && !editor.draft.id.trim()) {
      setEditor({ ...editor, error: 'ID 必填' })
      return
    }
    if (error) {
      setEditor({ ...editor, error })
      return
    }
    try {
      if (editor.creating) await createCard.mutateAsync({ id: editor.draft.id.trim(), ...fields })
      else {
        // Send only what the dialog changed, so an untouched lane cannot overwrite a concurrent move.
        const changed = changedFields(editor.original, fields)
        if (Object.keys(changed).length > 0) await patchCard.mutateAsync({ id: editor.draft.id, fields: changed })
      }
      setBoardError(null)
      setEditor({ ...editor, open: false, error: null })
    } catch (saveError) {
      setBoardError(null)
      setEditor({ ...editor, error: errorText(saveError) })
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>, lane: Lane) => {
    event.preventDefault()
    setDropLane(null)
    const id = event.dataTransfer.getData('text/plain')
    const card = cards.find((item) => item.id === id)
    if (card) moveCard(card, lane)
  }

  return (
    <AppShell>
      <div className="space-y-4 p-4 lg:p-5">
        <WorkstationPageTitle
          kicker="Todo"
          title="待辦看板"
          description="待辦 → 進行中 → 已完成待上線 → 已上線。已完成待上線的卡必須有預計上線日與包含的 PR。"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 rounded-full border border-[#3a3125] px-2 py-1 text-[11px] text-[#b9b1a1]">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                顯示封存
              </label>
              <button
                type="button"
                onClick={() => void cardsQuery.refetch()}
                className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/30 px-2 py-1 text-[11px] text-[#f1c16f]"
              >
                <RefreshCw className={`h-3 w-3 ${cardsQuery.isFetching ? 'animate-spin' : ''}`} /> 重新整理
              </button>
              <button
                type="button"
                onClick={() => openEditor(null)}
                className="inline-flex items-center gap-1 rounded-full border border-[#d6a85f]/50 bg-[#d6a85f]/10 px-2.5 py-1 text-[11px] text-[#f1c16f]"
              >
                <Plus className="h-3 w-3" /> 新增卡片
              </button>
            </div>
          }
        />

        {cardsQuery.error && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            待辦 API 載入失敗：{errorText(cardsQuery.error)}
          </div>
        )}
        {boardError && (
          <div className="flex items-start justify-between gap-2 rounded-xl border border-rose-400/30 bg-rose-400/[0.05] p-3 text-sm text-rose-200">
            <span className="break-words">{boardError}</span>
            <button type="button" onClick={() => setBoardError(null)} className="shrink-0 text-[11px] text-rose-100">關閉</button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((lane) => {
            const laneCards = cards.filter((card) => card.lane === lane.id)
            return (
              <WorkstationPanel
                key={lane.id}
                title={lane.label}
                kicker={lane.id}
                className="min-w-0"
                action={<WorkstationPill tone={lane.tone}>{laneCards.length}</WorkstationPill>}
              >
                <div
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropLane(lane.id) }}
                  onDragLeave={() => setDropLane((current) => (current === lane.id ? null : current))}
                  onDrop={(event) => onDrop(event, lane.id)}
                  className={`min-h-40 space-y-2 p-3 transition-colors ${dropLane === lane.id ? 'bg-[#d6a85f]/[0.06]' : ''}`}
                >
                  {cardsQuery.isLoading && <p className="text-xs text-[#70809b]">載入中…</p>}
                  {!cardsQuery.isLoading && laneCards.length === 0 && (
                    <p className="text-xs text-[#70809b]">沒有卡片，可拖曳到這裡。</p>
                  )}
                  {laneCards.map((card) => (
                    <TodoCardView
                      key={card.id}
                      card={card}
                      onMove={moveCard}
                      onEdit={(target) => openEditor(target)}
                      onArchive={(target, archived) => { setBoardError(null); archiveCard.mutate({ id: target.id, archived }) }}
                    />
                  ))}
                </div>
              </WorkstationPanel>
            )
          })}
        </div>
      </div>

      <CardEditor
        open={editor.open}
        creating={editor.creating}
        draft={editor.draft}
        setDraft={(draft) => setEditor({ ...editor, draft })}
        error={editor.error}
        saving={patchCard.isPending || createCard.isPending}
        onClose={() => setEditor({ ...editor, open: false, error: null })}
        onSave={() => void saveEditor()}
      />
    </AppShell>
  )
}
