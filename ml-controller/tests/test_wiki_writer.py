from __future__ import annotations

import sys
from types import SimpleNamespace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.wiki_writer import (
    append_moc_links_to_local_vault,
    bootstrap_wiki_vault,
    build_wiki_guard_report,
    build_wiki_start_task_context,
    build_wiki_recall_context,
    build_wiki_recall_receipt,
    build_wiki_note_dry_run,
    ensure_project_hub,
    finish_wiki_task,
    inspect_wiki_vault,
    search_wiki_vault,
    write_wiki_note_to_local_vault,
)  # noqa: E402


def test_wiki_note_dry_run_builds_product_decision_with_frontmatter_and_links():
    result = build_wiki_note_dry_run(
        {
            "product": "StockVision",
            "type": "decision",
            "title": "Obsidian Wiki Architecture Decision",
            "body": "Decision: use a shared Wei-Codex vault with product-scoped folders.",
            "source_refs": ["codex-session:2026-05-08"],
            "source_files": ["ml-controller/services/obsidian_writer.py"],
            "related": ["[[MOC-StockVision]]", "MOC-Obsidian-Wiki"],
            "tags": ["stockvision/wiki", "obsidian"],
        },
        now="2026-05-08T12:34:56+08:00",
    )

    assert result["status"] == "dry_run"
    assert result["files"][0]["path"] == (
        "02_Products/StockVision/"
        "決策紀錄_decisions/"
        "2026-05-08-obsidian-wiki-architecture-decision.md"
    )
    content = result["files"][0]["content"]
    assert "type: decision" in content
    assert "status: draft" in content
    assert "created: 2026-05-08" in content
    assert "- codex-session:2026-05-08" in content
    assert "- ml-controller/services/obsidian_writer.py" in content
    assert "- [[MOC-StockVision]]" in content
    assert "- [[MOC-Obsidian-Wiki]]" in content
    assert "Decision: use a shared Wei-Codex vault" in content
    assert result["moc_suggestions"] == ["06_MOC/MOC-Home.md", "02_Products/StockVision/超級連結_moc/MOC-StockVision.md"]


def test_wiki_session_notes_default_to_draft_filename():
    result = build_wiki_note_dry_run(
        {
            "product": "StockVision",
            "type": "session",
            "title": "Obsidian implementation kickoff",
            "body": "Checked branch isolation and started wiki writer implementation.",
        },
        now="2026-05-08T18:00:00+08:00",
    )

    assert result["files"][0]["path"] == (
        "02_Products/StockVision/"
        "Sessions/"
        "2026-05-08-obsidian-implementation-kickoff.draft.md"
    )
    assert "type: session" in result["files"][0]["content"]
    assert "status: draft" in result["files"][0]["content"]


def test_wiki_writer_blocks_secret_values():
    with pytest.raises(ValueError, match="secret_like_content"):
        build_wiki_note_dry_run(
            {
                "product": "StockVision",
                "type": "runbook",
                "title": "Bad secret note",
                "body": "Never write this token: ghp_abcdefghijklmnopqrstuvwxyz123456",
            },
            now="2026-05-08T12:00:00+08:00",
        )


def test_wiki_writer_sanitizes_slug_and_rejects_path_escape():
    result = build_wiki_note_dry_run(
        {
            "product": "StockVision",
            "type": "research",
            "title": "../ML Intern: TabM vs TimesFM?",
            "body": "Research-only benchmark note.",
            "slug": "../tabm-timesfm",
        },
        now="2026-05-08T12:00:00+08:00",
    )

    assert ".." not in result["files"][0]["path"]
    assert result["files"][0]["path"].endswith("2026-05-08-tabm-timesfm.md")


def test_wiki_research_note_routes_to_named_intern_track():
    result = build_wiki_note_dry_run(
        {
            "product": "StockVision",
            "type": "research",
            "research_track": "ML-Intern",
            "title": "TabM benchmark note",
            "body": "Research-only ML intern benchmark evidence.",
        },
        now="2026-05-08T12:00:00+08:00",
    )

    assert result["files"][0]["path"] == (
        "02_Products/StockVision/"
        "研究_research/ML-Intern/"
        "2026-05-08-tabm-benchmark-note.md"
    )


def test_wiki_research_note_rejects_unknown_track():
    with pytest.raises(ValueError, match="unsupported_research_track"):
        build_wiki_note_dry_run(
            {
                "product": "StockVision",
                "type": "research",
                "research_track": "production-promote",
                "title": "Bad research track",
                "body": "Unknown tracks should not create ad hoc folders.",
            },
            now="2026-05-08T12:00:00+08:00",
        )


def test_wiki_writer_writes_note_inside_local_vault(monkeypatch):
    written: dict[str, tuple[str, str | None]] = {}
    mkdir_calls: list[Path] = []

    monkeypatch.setattr(Path, "exists", lambda self: False)
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: mkdir_calls.append(self))
    monkeypatch.setattr(
        Path,
        "write_text",
        lambda self, content, encoding=None: written.setdefault(str(self), (content, encoding)) and len(content),
    )

    result = write_wiki_note_to_local_vault(
        {
            "product": "StockVision",
            "type": "session",
            "title": "Obsidian local write smoke",
            "body": "Local vault persistence should be explicit and confirmed.",
            "related": ["MOC-StockVision"],
        },
        vault_root="C:/wiki-vault",
        now="2026-05-08T20:00:00+08:00",
    )

    file_info = result["files"][0]

    assert result["status"] == "written"
    assert file_info["path"] == (
        "02_Products/StockVision/"
        "Sessions/"
        "2026-05-08-obsidian-local-write-smoke.draft.md"
    )
    assert file_info["absolute_path"].startswith("C:\\wiki-vault\\")
    assert file_info["wikilink"] == (
        "[[02_Products/StockVision/Sessions/2026-05-08-obsidian-local-write-smoke.draft|"
        "Obsidian local write smoke]]"
    )
    assert mkdir_calls
    content, encoding = written[file_info["absolute_path"]]
    assert encoding == "utf-8"
    assert "Local vault persistence should be explicit" in content
    assert "- [[MOC-StockVision]]" in content


def test_wiki_writer_refuses_to_overwrite_existing_local_note(monkeypatch):
    monkeypatch.setattr(Path, "exists", lambda self: True)

    payload = {
        "product": "StockVision",
        "type": "session",
        "title": "Duplicate session",
        "body": "First write wins unless overwrite is explicit.",
    }

    with pytest.raises(ValueError, match="wiki_note_exists"):
        write_wiki_note_to_local_vault(payload, vault_root="C:/wiki-vault", now="2026-05-08T20:00:00+08:00")


def test_search_wiki_vault_returns_ranked_retrieval_hits(monkeypatch):
    decision_path = Path("C:/wiki-vault/02_Products/StockVision/decisions/2026-05-08-obsidian-memory.md")
    session_path = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-08-random.draft.md")
    contents = {
        str(decision_path): """---
type: decision
status: approved
title: Obsidian Memory Rule
---
# Obsidian Memory Rule

Search Obsidian before guessing when prior StockVision context matters.
""",
        str(session_path): """---
type: session
status: draft
title: Random Session
---
# Random Session

No relevant content here.
""",
    }

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [decision_path, session_path])
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: contents[str(self)])

    result = search_wiki_vault(
        "obsidian guessing",
        vault_root="C:/wiki-vault",
        product="StockVision",
        max_results=5,
    )

    assert result["status"] == "searched"
    assert result["count"] == 1
    assert result["results"][0]["path"].endswith("2026-05-08-obsidian-memory.md")
    assert result["results"][0]["type"] == "decision"
    assert result["results"][0]["status"] == "approved"
    assert result["results"][0]["title"] == "Obsidian Memory Rule"
    assert result["results"][0]["matched_terms"] == ["obsidian", "guessing"]
    assert result["results"][0]["wikilink"] == (
        "[[02_Products/StockVision/decisions/2026-05-08-obsidian-memory|Obsidian Memory Rule]]"
    )
    assert "before guessing" in result["results"][0]["snippet"]
    assert "schema_version" not in result["results"][0]["snippet"]
    assert "title:" not in result["results"][0]["snippet"]


def test_search_wiki_vault_requires_non_empty_query():
    with pytest.raises(ValueError, match="query_required"):
        search_wiki_vault("   ", vault_root="C:/wiki-vault")


def test_build_wiki_recall_context_returns_citable_hits(monkeypatch):
    note_path = Path("C:/wiki-vault/02_Products/StockVision/決策紀錄_decisions/2026-05-08-memory.md")
    content = """---
type: decision
status: approved
title: Memory Rule
---
# Memory Rule

Search Obsidian before guessing.
"""

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [note_path])
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: content)

    result = build_wiki_recall_context(
        "obsidian guessing",
        vault_root="C:/wiki-vault",
        product="StockVision",
        max_results=3,
    )

    assert result["status"] == "found"
    assert result["answer_policy"] == "cite_wiki_hits"
    assert result["citations"][0]["path"].endswith("2026-05-08-memory.md")
    assert result["citations"][0]["wikilink"].endswith("|Memory Rule]]")
    assert "before guessing" in result["citations"][0]["snippet"]


def test_build_wiki_recall_receipt_returns_copy_paste_block(monkeypatch):
    note_path = Path("C:/wiki-vault/02_Products/StockVision/決策紀錄_decisions/2026-05-08-memory.md")
    content = """---
type: decision
status: approved
title: Memory Rule
---
# Memory Rule

Search Obsidian before guessing.
"""

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [note_path])
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: content)

    result = build_wiki_recall_receipt(
        "obsidian guessing",
        vault_root="C:/wiki-vault",
        product="StockVision",
        max_results=3,
    )

    assert result["status"] == "receipt"
    assert result["recall"]["status"] == "found"
    assert "Obsidian recall receipt:" in result["text"]
    assert '- query: "obsidian guessing"' in result["text"]
    assert "- status: found" in result["text"]
    assert "- answer_policy: cite_wiki_hits" in result["text"]
    assert "02_Products/StockVision/決策紀錄_decisions/2026-05-08-memory.md" in result["text"]


def test_build_wiki_recall_context_returns_unknown_policy_when_no_hits(monkeypatch):
    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [])

    result = build_wiki_recall_context(
        "missing context",
        vault_root="C:/wiki-vault",
        product="StockVision",
    )

    assert result["status"] == "not_found"
    assert result["answer_policy"] == "say_unknown_then_check_repo_or_logs"
    assert result["citations"] == []
    assert "wiki 沒找到相關記憶" in result["message"]


def test_build_wiki_recall_receipt_returns_none_when_no_hits(monkeypatch):
    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [])

    result = build_wiki_recall_receipt(
        "missing context",
        vault_root="C:/wiki-vault",
        product="StockVision",
    )

    assert result["recall"]["status"] == "not_found"
    assert "- status: not_found" in result["text"]
    assert "- answer_policy: say_unknown_then_check_repo_or_logs" in result["text"]
    assert "  - None" in result["text"]


def test_search_wiki_vault_uses_retrieval_ladder_scopes(monkeypatch):
    global_moc = Path("C:/wiki-vault/06_MOC/MOC-Home.md")
    decision = Path("C:/wiki-vault/02_Products/StockVision/決策紀錄_decisions/2026-05-08-memory.md")
    session = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-08-memory.draft.md")
    contents = {
        str(global_moc): """---
type: moc
status: active
title: MOC Home
---
# MOC Home

Obsidian memory retrieval entrypoint.
""",
        str(decision): """---
type: decision
status: approved
title: Memory Retrieval Decision
---
# Memory Retrieval Decision

Search Obsidian memory before guessing.
""",
        str(session): """---
type: session
status: draft
title: Memory Session
---
# Memory Session

Obsidian memory implementation detail.
""",
    }
    scoped_files = {
        "C:\\wiki-vault\\06_MOC": [global_moc],
        "C:\\wiki-vault\\02_Products\\StockVision\\決策紀錄_decisions": [decision],
        "C:\\wiki-vault\\02_Products\\StockVision\\Sessions": [session],
    }

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: scoped_files.get(str(self), []))
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: contents[str(self)])

    result = search_wiki_vault(
        "obsidian memory",
        vault_root="C:/wiki-vault",
        product="StockVision",
        max_results=10,
    )

    assert "global_moc" in result["searched_scopes"]
    assert "decisions" in result["searched_scopes"]
    assert "sessions" in result["searched_scopes"]
    assert {row["scope"] for row in result["results"]} == {"global_moc", "decisions", "sessions"}
    assert result["results"][0]["scope"] == "decisions"


def test_append_moc_links_to_local_vault_adds_note_link_once(monkeypatch):
    moc_path = Path("C:/wiki-vault/02_Products/StockVision/超級連結_moc/MOC-StockVision.md")
    written: dict[str, str] = {}
    existing = "# MOC-StockVision\n\n## Linked Notes\n\n<!-- wiki-writer-links -->\n"
    write_result = {
        "moc_suggestions": ["02_Products/StockVision/超級連結_moc/MOC-StockVision.md"],
        "files": [
            {
                "path": "02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft.md",
                "title": "Obsidian CLI",
                "wikilink": "[[02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft|Obsidian CLI]]",
            }
        ],
    }

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: existing)
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(Path, "write_text", lambda self, content, encoding=None: written.setdefault(str(self), content) and len(content))

    result = append_moc_links_to_local_vault(write_result, vault_root="C:/wiki-vault")

    assert result["status"] == "moc_updated"
    assert result["updated_mocs"][0]["path"] == "02_Products/StockVision/超級連結_moc/MOC-StockVision.md"
    updated_content = written[str(moc_path)]
    assert updated_content.count("[[02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft|Obsidian CLI]]") == 1


def test_append_moc_links_to_local_vault_skips_existing_link(monkeypatch):
    link = "[[02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft|Obsidian CLI]]"
    existing = f"# MOC-StockVision\n\n## Linked Notes\n\n<!-- wiki-writer-links -->\n- {link}\n"
    write_result = {
        "moc_suggestions": ["02_Products/StockVision/超級連結_moc/MOC-StockVision.md"],
        "files": [
            {
                "path": "02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft.md",
                "title": "Obsidian CLI",
                "wikilink": link,
            }
        ],
    }

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: existing)
    monkeypatch.setattr(Path, "write_text", lambda self, content, encoding=None: (_ for _ in ()).throw(AssertionError("duplicate write")))

    result = append_moc_links_to_local_vault(write_result, vault_root="C:/wiki-vault")

    assert result["status"] == "moc_updated"
    assert result["updated_mocs"] == []
    assert result["unchanged_mocs"] == ["02_Products/StockVision/超級連結_moc/MOC-StockVision.md"]


def test_inspect_wiki_vault_reports_ok_with_recent_session(monkeypatch):
    session_path = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-08-obsidian-health.draft.md")
    notes_by_scope = {
        "C:\\wiki-vault\\06_MOC": [Path("C:/wiki-vault/06_MOC/MOC-Home.md")],
        "C:\\wiki-vault\\02_Products\\StockVision\\Sessions": [session_path],
    }

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: notes_by_scope.get(str(self), []))

    result = inspect_wiki_vault(
        vault_root="C:/wiki-vault",
        product="StockVision",
        now="2026-05-08T22:30:00+08:00",
    )

    assert result["status"] == "ok"
    assert result["missing_required"] == []
    assert result["latest_session"]["path"] == "02_Products/StockVision/Sessions/2026-05-08-obsidian-health.draft.md"
    assert result["latest_session"]["days_since"] == 0
    assert result["note_counts"]["sessions"] == 1


def test_inspect_wiki_vault_uses_mtime_for_same_day_latest_session(monkeypatch):
    older_session = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-08-a-older.draft.md")
    newer_session = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-08-z-newer.draft.md")

    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(
        Path,
        "rglob",
        lambda self, pattern: [older_session, newer_session] if str(self).endswith("\\Sessions") else [],
    )
    monkeypatch.setattr(
        Path,
        "stat",
        lambda self: SimpleNamespace(st_mtime=200.0 if str(self).endswith("a-older.draft.md") else 100.0),
    )

    result = inspect_wiki_vault(
        vault_root="C:/wiki-vault",
        product="StockVision",
        now="2026-05-08T22:30:00+08:00",
    )

    assert result["latest_session"]["path"] == "02_Products/StockVision/Sessions/2026-05-08-a-older.draft.md"


def test_inspect_wiki_vault_reports_missing_required_and_stale_session(monkeypatch):
    session_path = Path("C:/wiki-vault/02_Products/StockVision/Sessions/2026-05-01-old-session.draft.md")
    existing = {
        "C:\\wiki-vault",
        "C:\\wiki-vault\\02_Products\\StockVision",
        "C:\\wiki-vault\\02_Products\\StockVision\\Sessions",
    }

    monkeypatch.setattr(Path, "exists", lambda self: str(self) in existing)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [session_path] if str(self).endswith("\\Sessions") else [])

    result = inspect_wiki_vault(
        vault_root="C:/wiki-vault",
        product="StockVision",
        now="2026-05-08T22:30:00+08:00",
        stale_days=3,
    )

    assert result["status"] == "degraded"
    assert "CLAUDE.md" in result["missing_required"]
    assert "06_MOC/MOC-Home.md" in result["missing_required"]
    assert "Templates/Session Draft.md" in result["missing_required"]
    assert "02_Products/StockVision/筆記製作規則_note-rules/Wiki Writing Rules.md" in result["missing_required"]
    assert result["latest_session"]["days_since"] == 7
    assert result["is_stale"] is True


def test_bootstrap_wiki_vault_creates_governance_files_and_product_structure(monkeypatch):
    directories: set[str] = set()
    files: dict[str, str] = {}

    def normalized(path: Path) -> str:
        return str(path).replace("\\", "/")

    monkeypatch.setattr(Path, "resolve", lambda self: self)
    monkeypatch.setattr(Path, "exists", lambda self: normalized(self) in directories or normalized(self) in files)
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: directories.add(normalized(self)))
    monkeypatch.setattr(Path, "write_text", lambda self, content, encoding=None: files.setdefault(normalized(self), content) and len(content))
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: files[normalized(self)])

    result = bootstrap_wiki_vault("C:/wiki-vault", product="StockVision")

    assert result["status"] == "bootstrapped"
    assert "CLAUDE.md" in result["created_files"]
    assert "06_MOC/MOC-Home.md" in result["created_files"]
    assert "02_Products/StockVision/超級連結_moc/MOC-StockVision.md" in result["created_files"]
    assert "02_Products/StockVision/超級連結_moc/MOC-Research-Intern.md" in result["created_files"]
    assert "02_Products/StockVision/超級連結_moc/MOC-ML-Intern.md" in result["created_files"]
    assert "02_Products/StockVision/筆記製作規則_note-rules/Wiki Writing Rules.md" in result["created_files"]
    assert "Templates/Session Draft.md" in result["created_files"]
    assert "Templates/Decision Note.md" in result["created_files"]
    assert "Templates/Research Note.md" in result["created_files"]
    assert "02_Products/StockVision/研究_research/Research-Intern" in result["created_directories"]
    assert "02_Products/StockVision/研究_research/ML-Intern" in result["created_directories"]

    claude = files["C:/wiki-vault/CLAUDE.md"]
    assert "Obsidian -> repo -> logs/runtime -> unknown" in claude
    assert "不要猜" in claude
    assert "Obsidian recall receipt" in claude
    assert "沒有 receipt 的回答視為未驗證" in claude

    writing_rules = files["C:/wiki-vault/02_Products/StockVision/筆記製作規則_note-rules/Wiki Writing Rules.md"]
    assert "wiki 是 Wei-Codex 長期記憶" in writing_rules
    assert "重大任務結束" in writing_rules
    assert "query" in writing_rules
    assert "citations" in writing_rules

    session_template = files["C:/wiki-vault/Templates/Session Draft.md"]
    assert "## Verification" in session_template
    assert "## Next" in session_template

    second = bootstrap_wiki_vault("C:/wiki-vault", product="StockVision")

    assert second["created_files"] == []
    assert "CLAUDE.md" in second["unchanged_files"]


def test_ensure_project_hub_creates_v4_project_anchor(monkeypatch):
    directories: set[str] = set()
    files: dict[str, str] = {}

    def normalized(path: Path) -> str:
        return str(path).replace("\\", "/")

    monkeypatch.setattr(Path, "resolve", lambda self: self)
    monkeypatch.setattr(Path, "exists", lambda self: normalized(self) in directories or normalized(self) in files)
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: directories.add(normalized(self)))
    monkeypatch.setattr(Path, "write_text", lambda self, content, encoding=None: files.setdefault(normalized(self), content) and len(content))

    result = ensure_project_hub("C:/wiki-vault", product="StockVision", title="V4 Refactor")

    assert result["status"] == "written"
    assert result["path"] == "02_Products/StockVision/專案_projects/v4-refactor.md"
    content = files["C:/wiki-vault/02_Products/StockVision/專案_projects/v4-refactor.md"]
    assert "# V4 Refactor" in content
    assert "Obsidian recall receipt" in content
    assert "## Decisions" in content
    assert "## Sessions" in content

    second = ensure_project_hub("C:/wiki-vault", product="StockVision", title="V4 Refactor")

    assert second["status"] == "unchanged"


def test_finish_wiki_task_writes_session_updates_moc_and_runs_doctor(monkeypatch):
    import services.wiki_writer as wiki_writer

    def fake_write(payload, *, vault_root, now=None, overwrite=False):
        return {
            "status": "written",
            "product": payload["product"],
            "type": payload["type"],
            "files": [{"path": "02_Products/StockVision/Sessions/2026-05-15-v4.draft.md"}],
            "moc_suggestions": ["06_MOC/MOC-Home.md"],
        }

    monkeypatch.setattr(wiki_writer, "write_wiki_note_to_local_vault", fake_write)
    monkeypatch.setattr(wiki_writer, "append_moc_links_to_local_vault", lambda result, *, vault_root: {"status": "moc_updated"})
    monkeypatch.setattr(wiki_writer, "inspect_wiki_vault", lambda *, vault_root, product, stale_days=3, now=None: {"status": "ok"})

    result = finish_wiki_task(
        "C:/wiki-vault",
        title="V4 task",
        body="Finished V4 planning task.",
        tags=["stockvision/v4"],
    )

    assert result["status"] == "finished"
    assert result["write"]["status"] == "written"
    assert result["moc_update"]["status"] == "moc_updated"
    assert result["health"]["status"] == "ok"


def test_build_wiki_guard_report_checks_health_project_hub_and_receipt(monkeypatch):
    import services.wiki_writer as wiki_writer

    monkeypatch.setattr(
        wiki_writer,
        "inspect_wiki_vault",
        lambda *, vault_root, product, stale_days=3, now=None: {
            "status": "ok",
            "missing_required": [],
            "is_stale": False,
        },
    )
    monkeypatch.setattr(Path, "resolve", lambda self: self)
    monkeypatch.setattr(Path, "exists", lambda self: str(self).replace("\\", "/").endswith("02_Products/StockVision/專案_projects/v4-refactor.md"))
    monkeypatch.setattr(
        wiki_writer,
        "build_wiki_recall_receipt",
        lambda query, *, vault_root, product, max_results=5, include_archived=False: {
            "status": "receipt",
            "text": "Obsidian recall receipt:",
            "recall": {"status": "found"},
        },
    )

    result = build_wiki_guard_report(
        "C:/wiki-vault",
        product="StockVision",
        project_slug="v4-refactor",
        query="V4 architecture decisions",
    )

    assert result["status"] == "ok"
    assert result["blocking_items"] == []
    assert result["project_hub"]["exists"] is True
    assert result["receipt"]["recall"]["status"] == "found"


def test_build_wiki_start_task_context_combines_guard_with_git_status(monkeypatch):
    import services.wiki_writer as wiki_writer

    def fake_build_wiki_guard_report(vault_root, *, product, project_slug, stale_days=3, query=None, max_results=5):
        return {
            "status": "ok",
            "product": product,
            "vault_root": vault_root,
            "blocking_items": [],
            "project_hub": {"path": f"02_Products/{product}/專案_projects/{project_slug}.md", "exists": True},
            "receipt": {"text": "Obsidian recall receipt:\n- status: found"},
        }

    class Completed:
        returncode = 0
        stdout = "## feature/ml-pool-v1...origin/feature/ml-pool-v1\n M ml-controller/services/wiki_writer.py\n"
        stderr = ""

    def fake_run(cmd, *, cwd, capture_output, text, encoding, errors, check):
        assert cmd == ["git", "status", "--short", "--branch"]
        assert str(cwd).endswith("stockvision-cloudflare-v12")
        assert capture_output is True
        assert encoding == "utf-8"
        assert check is False
        return Completed()

    monkeypatch.setattr(wiki_writer, "build_wiki_guard_report", fake_build_wiki_guard_report)
    monkeypatch.setattr("subprocess.run", fake_run)

    result = build_wiki_start_task_context(
        "C:/wiki-vault",
        product="StockVision",
        project_slug="v4-refactor",
        query="V4 next work",
        repo_cwd="C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12",
    )

    assert result["status"] == "ready"
    assert result["guard"]["status"] == "ok"
    assert result["git"]["branch"] == "feature/ml-pool-v1"
    assert result["git"]["dirty"] is True
    assert result["next_actions"] == ["Proceed with the task using receipt citations for prior-context claims."]
