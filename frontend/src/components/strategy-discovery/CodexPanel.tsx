import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, Clipboard, Download, FileArchive, ShieldAlert } from 'lucide-react'
import { strategyDiscoveryApi } from '@/lib/strategyDiscoveryApi'
import type { DashboardState } from '@/lib/strategyDiscoveryViewModel'
import { formatUtc } from '@/lib/strategyDiscoveryViewModel'

function saveBlob(blob: Blob, runId: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `jury-bundle-${runId}.zip`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function CodexPanel({ handoff, importing, error, onImport }: {
  handoff: NonNullable<DashboardState['codex_handoff']>
  importing: boolean
  error: string | null
  onImport: (file: File) => void
}) {
  const [copied, setCopied] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const downloading = useRef(false)

  const download = async () => {
    if (downloading.current) return
    downloading.current = true
    setDownloadError(null)
    try { saveBlob(await strategyDiscoveryApi.juryBundle(handoff.run_id), handoff.run_id) }
    catch (cause) { setDownloadError(cause instanceof Error ? cause.message : String(cause)) }
    finally { downloading.current = false }
  }

  useEffect(() => {
    const key = `strategy-discovery:bundle-downloaded:${handoff.bundle_hash}`
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
    void download()
  }, [handoff.bundle_hash])

  const accept = (file?: File) => {
    if (file) onImport(file)
  }
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    accept(event.dataTransfer.files[0])
  }

  return (
    <section className="border border-cyan-300/20 bg-[#0d1418]" aria-labelledby="codex-handoff-title">
      <div className="grid border-b border-cyan-200/10 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="p-5 sm:p-7">
          <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-cyan-300">Codex handoff</p>
          <h2 id="codex-handoff-title" className="mt-2 font-['Outfit'] text-2xl font-semibold">把證據帶到 repository 審判</h2>
          <dl className="mt-6 space-y-4 text-sm">
            <div><dt className="text-xs text-slate-500">Run ID</dt><dd className="mt-1 break-all font-mono text-slate-200">{handoff.run_id}</dd></div>
            <div><dt className="text-xs text-slate-500">Jury Bundle hash</dt><dd className="mt-1 break-all font-mono text-[11px] text-slate-300">{handoff.bundle_hash}</dd></div>
            <div><dt className="text-xs text-slate-500">建立時間</dt><dd className="mt-1 text-slate-300">{formatUtc(handoff.bundle_created_at)}</dd></div>
            <div><dt className="text-xs text-slate-500">Repo Skill</dt><dd className="mt-1 font-mono text-cyan-200">${handoff.repo_skill}</dd></div>
          </dl>
          <a href="#download-jury-bundle" onClick={(event) => { event.preventDefault(); void download() }} className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-cyan-200 underline decoration-cyan-300/40 underline-offset-4 hover:text-white">
            <Download className="h-4 w-4" />下載 Jury Bundle
          </a>
          {downloadError && <p className="mt-2 text-xs text-red-300">{downloadError}</p>}
        </div>

        <div className="border-t border-cyan-200/10 p-5 lg:border-l lg:border-t-0 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Codex 指令</p>
            <button type="button" onClick={() => { void navigator.clipboard.writeText(handoff.command); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }} className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-slate-400 hover:border-cyan-300/40 hover:text-cyan-200" aria-label="複製 Codex 指令">
              {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            </button>
          </div>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-cyan-300/50 bg-black/25 p-4 font-mono text-[11px] leading-6 text-slate-300">{handoff.command}</pre>
          <p className="mt-4 text-xs leading-5 text-slate-500">在 Codex App 執行 repo skill；Codex 必須以程式碼與可執行測試驗證所有 material claims，再輸出 codex-result.zip。</p>
        </div>
      </div>

      <label
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
        className={`m-5 grid min-h-36 cursor-pointer place-items-center border border-dashed p-6 text-center transition sm:m-7 ${importing ? 'border-amber-300/50 bg-amber-300/5' : 'border-cyan-300/30 hover:border-cyan-200/70 hover:bg-cyan-300/[0.035]'}`}
      >
        <input type="file" accept=".zip,application/zip" className="sr-only" disabled={importing} onChange={(event) => accept(event.target.files?.[0])} />
        <span>
          {importing ? <ShieldAlert className="mx-auto h-7 w-7 animate-pulse text-amber-200" /> : <FileArchive className="mx-auto h-7 w-7 text-cyan-200" />}
          <span className="mt-3 block text-sm font-semibold text-slate-100">{importing ? '驗證並匯入中' : '將 codex-result.zip 拖曳到此處'}</span>
          <span className="mt-1 block text-xs text-slate-500">放入後自動驗證 Run／Bundle／Candidate／Issue hash，不需要第三個按鈕。</span>
        </span>
      </label>
      {error && <p role="alert" className="mx-5 mb-5 border-l-2 border-red-400 bg-red-400/5 px-4 py-3 text-sm text-red-200 sm:mx-7 sm:mb-7">{error}</p>}
    </section>
  )
}
