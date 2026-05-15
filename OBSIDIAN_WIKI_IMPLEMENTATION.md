# Obsidian Wiki Implementation

## Decision

Use a clean shared vault:

```text
C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki
```

The vault is shared Wei-Codex memory. StockVision is one product section, not
the whole vault.

## Folder Contract

```text
wei-codex-wiki/
  CLAUDE.md
  00_Inbox/
  01_Global/
  02_Products/
    StockVision/
      文章原文_source-articles/
      每日文章_daily-articles/
      筆記製作規則_note-rules/
        Wiki Writing Rules.md
      超級連結_moc/
        MOC-StockVision.md
        MOC-Research-Intern.md
        MOC-ML-Intern.md
      關鍵字字典_glossary/
      Change-Log/
      專案_projects/
      決策紀錄_decisions/
      系統架構_architecture/
      Runbooks/
      研究_research/
        Research-Intern/
        ML-Intern/
      Postmortems/
      Sessions/
      Ops/
  03_Tooling/
  04_Research-Library/
  05_Change-Log/
  06_MOC/
    MOC-Home.md
  Templates/
    Session Draft.md
    Decision Note.md
    Research Note.md
  99_Archive/
```

## Legacy Boundary

`ml-controller/services/obsidian_writer.py` remains an ops snapshot exporter.
Its Daily / Trades / Pipeline / Audits / Current-State output is audit trail,
not long-term wiki memory.

## New Writer

`ml-controller/services/wiki_writer.py` builds structured wiki note payloads.
It is dry-run first and rejects secret-like content before rendering.

Supported note types:

- `decision`
- `architecture`
- `runbook`
- `research`
- `postmortem`
- `session`
- `source`
- `daily`
- `glossary`

Research notes may include:

```json
{
  "type": "research",
  "research_track": "Research-Intern"
}
```

or:

```json
{
  "type": "research",
  "research_track": "ML-Intern"
}
```

These route notes into the dedicated `研究_research/Research-Intern/` and
`研究_research/ML-Intern/` folders. Unknown research tracks are rejected instead
of creating ad hoc folders.

Session notes default to:

```text
02_Products/<Product>/Sessions/YYYY-MM-DD-topic.draft.md
```

Local persistence is enabled only when:

```text
OBSIDIAN_WIKI_VAULT_PATH=C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki
```

The local writer still requires an explicit `confirm=true` request and refuses
to overwrite an existing note by default.

## Wiki Retrieval

`ml-controller/services/wiki_writer.py` also exposes local vault search for the
no-guess memory rule. It searches product-scoped markdown notes, extracts
frontmatter, ranks matches, and returns path + snippet evidence for citation.

The search ladder is explicit:

1. `06_MOC/`
2. `01_Global/`
3. `02_Products/<Product>/超級連結_moc/`
4. `02_Products/<Product>/決策紀錄_decisions/`
5. `02_Products/<Product>/系統架構_architecture/`
6. `02_Products/<Product>/Runbooks/`
7. `02_Products/<Product>/Postmortems/`
8. `02_Products/<Product>/研究_research/`
9. `02_Products/<Product>/關鍵字字典_glossary/`
10. `02_Products/<Product>/文章原文_source-articles/`
11. `02_Products/<Product>/每日文章_daily-articles/`
12. `02_Products/<Product>/Sessions/`
13. `00_Inbox/`

Each hit includes `scope`, `path`, `wikilink`, `title`, `type`, `status`,
`matched_terms`, and a body-only `snippet`, so answers can cite the exact note
path instead of relying on implicit memory.

This retrieval layer is for memory recovery:

- past decisions
- approved / rejected directions
- architecture notes
- runbooks
- research notes
- postmortems
- session drafts

It is not the source of live production truth; repo code and runtime logs still
win for current behavior.

## Endpoints

Preview:

```http
POST /obsidian/wiki-note/dry-run
```

Write path:

```http
POST /obsidian/wiki-note
```

The write endpoint is fail-closed:

- `confirm=true` is required.
- If `OBSIDIAN_WIKI_VAULT_PATH` is configured, the note is written to the local vault.
- Set `update_moc=true` to append the written note link to suggested MOC files.
- If no local vault is configured, `GITHUB_REPO_WIKI` is the future persistence path.
- Current GitHub persistence is intentionally not wired yet.

Bootstrap path:

```http
POST /obsidian/wiki-bootstrap
```

The bootstrap endpoint requires `OBSIDIAN_WIKI_VAULT_PATH` and `confirm=true`.
It creates the local vault skeleton used by the CLI bootstrap command and is
idempotent unless `overwrite=true` is explicitly passed.

Search path:

```http
POST /obsidian/wiki-search
```

The search endpoint requires `OBSIDIAN_WIKI_VAULT_PATH` and returns ranked local
vault hits. Use it before answering any question that depends on prior context.

Recall path:

```http
POST /obsidian/wiki-recall
```

The recall endpoint requires `OBSIDIAN_WIKI_VAULT_PATH` and wraps search results
into a no-guess context pack with `answer_policy` and `citations`. If the wiki
has no matching note, the response explicitly says to answer `unknown` before
checking repo code, runtime logs, or external docs.

For any answer involving prior decisions, preferences, architecture, workflow,
or Obsidian/wiki/memory, the agent must include an observable `Obsidian recall
receipt` with query, status, answer_policy, and citations. Without that receipt,
the answer is treated as unverified memory recovery.

Receipt path:

```http
POST /obsidian/wiki-recall-receipt
```

The receipt endpoint uses the same request shape as recall and returns a
copy-pasteable `text` block. Agents should prefer this endpoint or the CLI
`recall-receipt` command over hand-writing receipts.

Health path:

```http
POST /obsidian/wiki-health
```

The health endpoint requires `OBSIDIAN_WIKI_VAULT_PATH` and returns required
vault structure checks, retrieval-scope note counts, and latest session
freshness.

The legacy GitHub vault `/obsidian/health` path imports `httpx` lazily inside
that handler, so local wiki endpoints can still load in environments that only
need filesystem-backed wiki tools.

## Local CLI

For Codex sessions, use the local CLI instead of ad hoc Python one-liners:

Bootstrap a clean vault skeleton:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py bootstrap --confirm
```

`bootstrap` creates the root governance file, global MOC, product MOC,
Research-Intern MOC, ML-Intern MOC, Wiki Writing Rules, note templates, and the
Chinese-display / English-slug folder contract. It is idempotent and does not
overwrite existing files unless `--overwrite` is explicitly provided.

Search:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py search --query "obsidian retrieval"
```

No-guess recall context:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py recall --query "past decision or preference" --max-results 5
```

`recall` wraps search results into a context pack with `answer_policy` and
`citations`. If no wiki hit is found, it returns `not_found` and instructs the
agent to say the wiki has no matching memory before checking repo / logs /
runtime.

Required answer receipt:

```text
Obsidian recall receipt:
- query: "past decision or preference"
- status: found / not_found
- answer_policy: cite_wiki_hits / say_unknown_then_check_repo_or_logs
- citations:
  - 02_Products/StockVision/...
```

Copy-pasteable receipt:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py recall-receipt --query "past decision or preference" --max-results 5
```

Vault health:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py doctor --stale-days 3
```

`doctor` checks required governance files, required product folders, note counts
by retrieval scope, and whether the latest session draft is stale.

Structured note:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py note --type decision --title "Decision title" --body "Decision body with evidence." --update-moc --confirm
```

Research track note:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py note --type research --research-track ML-Intern --title "Benchmark note" --body "Research-only evidence." --update-moc --confirm
```

Session draft:

```powershell
$env:OBSIDIAN_WIKI_VAULT_PATH="C:\Users\Wei\Desktop\CloudCode\wei-codex-wiki"
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe ml-controller\scripts\wiki_tool.py session-draft --title "Task title" --body "What changed and how it was verified." --update-moc --confirm
```

`session-draft` is intentionally fail-closed and refuses to write unless
`--confirm` is provided. Add `--update-moc` to append the new note link to the
suggested MOC files. MOC updates use the `<!-- wiki-writer-links -->` marker
and skip links that already exist, so repeated runs do not duplicate backlinks.

## Research Intern Mapping

Research intern output should write to:

```text
02_Products/StockVision/研究_research/Research-Intern/
```

Relevant source modules:

- `worker/src/lib/researchInternGate.ts`
- `worker/src/lib/researchExperimentRegistry.ts`
- `worker/src/lib/researchEvaluationPlan.ts`
- `worker/src/lib/researchEvaluationRunner.ts`

Allowed: source reading, hypothesis, experiment registry, dry-run evaluation,
review packets.

Blocked: production retrain, model promote, deploy, trading execution.

## ML Intern Mapping

ML intern-like output should write to:

```text
02_Products/StockVision/研究_research/ML-Intern/
```

Relevant source modules:

- `worker/src/lib/modelUpgradeResearchTrack.ts`
- `ml-controller/routers/research_benchmark.py`
- `ml-controller/services/research_model_benchmark.py`
- `ml-service/modal_app.py`
- `worker/src/lib/optunaQueue.ts`

The current system supports research-only model-family benchmark evidence. It
is not a full autonomous Hugging Face `ml-intern` style CLI/agent loop yet.

## Verification

Run targeted tests from the clean worktree:

```powershell
& C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m pytest -p no:cacheprovider ml-controller\tests\test_wiki_writer.py ml-controller\tests\test_obsidian_wiki_router.py
```
