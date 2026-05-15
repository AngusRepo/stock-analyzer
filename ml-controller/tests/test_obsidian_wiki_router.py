from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException  # noqa: E402
from routers.obsidian import (
    WikiBootstrapRequest,
    WikiHealthRequest,
    WikiNoteRequest,
    WikiRecallRequest,
    WikiSearchRequest,
    bootstrap_wiki_vault_endpoint,
    build_wiki_note_preview,
    build_wiki_recall_receipt_endpoint,
    inspect_wiki_health,
    recall_wiki_context,
    search_wiki_notes,
    write_wiki_note,
)  # noqa: E402


def test_wiki_note_dry_run_endpoint_returns_file_payload():
    body = asyncio.run(
        build_wiki_note_preview(
            WikiNoteRequest(
                product="StockVision",
                type="research",
                title="ML Intern benchmark track",
                body="Research-only benchmark notes for TabM and TimesFM.",
                related=["MOC-ML-Intern"],
            )
        )
    )

    assert body["status"] == "dry_run"
    assert body["files"][0]["path"].startswith("02_Products/StockVision/")
    assert body["files"][0]["path"].endswith("ml-intern-benchmark-track.md")
    assert "[[MOC-ML-Intern]]" in body["files"][0]["content"]


def test_wiki_note_dry_run_endpoint_routes_research_track():
    body = asyncio.run(
        build_wiki_note_preview(
            WikiNoteRequest(
                product="StockVision",
                type="research",
                research_track="Research-Intern",
                title="Factor hypothesis review",
                body="Research intern hypothesis and source review.",
            )
        )
    )

    assert body["files"][0]["path"].startswith("02_Products/StockVision/研究_research/Research-Intern/")
    assert body["files"][0]["path"].endswith("-factor-hypothesis-review.md")


def test_wiki_note_write_endpoint_requires_confirm_flag():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            write_wiki_note(
                WikiNoteRequest(
                    product="StockVision",
                    type="decision",
                    title="Should not write without confirm",
                    body="This route must fail closed unless confirm is true.",
                    confirm=False,
                )
            )
        )

    assert exc.value.status_code == 400
    assert exc.value.detail == "wiki note write requires confirm=true"


def test_wiki_bootstrap_endpoint_requires_confirm_flag(monkeypatch):
    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(bootstrap_wiki_vault_endpoint(WikiBootstrapRequest(confirm=False)))

    assert exc.value.status_code == 400
    assert exc.value.detail == "wiki bootstrap requires confirm=true"


def test_wiki_bootstrap_endpoint_uses_configured_local_vault(monkeypatch):
    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_bootstrap_wiki_vault(vault_root, *, product, overwrite=False):
        return {
            "status": "bootstrapped",
            "vault_root": str(vault_root),
            "product": product,
            "overwrite": overwrite,
            "created_files": ["CLAUDE.md"],
        }

    import routers.obsidian as obsidian_router

    monkeypatch.setattr(obsidian_router, "bootstrap_wiki_vault", fake_bootstrap_wiki_vault, raising=False)

    body = asyncio.run(
        bootstrap_wiki_vault_endpoint(
            WikiBootstrapRequest(product="StockVision", overwrite=True, confirm=True)
        )
    )

    assert body["status"] == "bootstrapped"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["product"] == "StockVision"
    assert body["overwrite"] is True
    assert body["created_files"] == ["CLAUDE.md"]


def test_wiki_note_write_endpoint_writes_to_configured_local_vault(monkeypatch):
    written: dict[str, tuple[str, str | None]] = {}

    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")
    monkeypatch.setattr(Path, "exists", lambda self: False)
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(
        Path,
        "write_text",
        lambda self, content, encoding=None: written.setdefault(str(self), (content, encoding)) and len(content),
    )

    body = asyncio.run(
        write_wiki_note(
            WikiNoteRequest(
                product="StockVision",
                type="session",
                title="Router local vault write",
                body="The route should write only when confirm is true and a local vault is configured.",
                confirm=True,
            )
        )
    )

    assert body["status"] == "written"
    assert body["files"][0]["absolute_path"].startswith("C:\\wiki-vault\\")
    content, encoding = written[body["files"][0]["absolute_path"]]
    assert encoding == "utf-8"
    assert "Router local vault write" in content


def test_wiki_note_write_endpoint_can_update_moc(monkeypatch):
    written: dict[str, tuple[str, str | None]] = {}
    moc_writes: list[str] = []

    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")
    monkeypatch.setattr(Path, "exists", lambda self: str(self).endswith("MOC-StockVision.md"))
    monkeypatch.setattr(Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: "# MOC-StockVision\n\n<!-- wiki-writer-links -->\n")

    def fake_write_text(self, content, encoding=None):
        if str(self).endswith("MOC-StockVision.md"):
            moc_writes.append(content)
        else:
            written.setdefault(str(self), (content, encoding))
        return len(content)

    monkeypatch.setattr(Path, "write_text", fake_write_text)

    body = asyncio.run(
        write_wiki_note(
            WikiNoteRequest(
                product="StockVision",
                type="session",
                title="Router update MOC",
                body="The route should optionally update MOC links.",
                confirm=True,
                update_moc=True,
            )
        )
    )

    assert body["status"] == "written"
    assert "moc_update" in body
    assert body["moc_update"]["updated_mocs"]
    assert "Router update MOC" in moc_writes[0]


def test_wiki_search_endpoint_uses_configured_local_vault(monkeypatch):
    note_path = Path("C:/wiki-vault/02_Products/StockVision/decisions/2026-05-08-memory.md")
    content = """---
type: decision
status: approved
title: Retrieval Rule
---
# Retrieval Rule

Search Obsidian before guessing.
"""

    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")
    monkeypatch.setattr(Path, "exists", lambda self: True)
    monkeypatch.setattr(Path, "is_file", lambda self: True)
    monkeypatch.setattr(Path, "rglob", lambda self, pattern: [note_path])
    monkeypatch.setattr(Path, "read_text", lambda self, encoding=None, errors=None: content)

    body = asyncio.run(search_wiki_notes(WikiSearchRequest(query="obsidian guessing")))

    assert body["status"] == "searched"
    assert body["count"] == 1
    assert body["results"][0]["title"] == "Retrieval Rule"
    assert body["results"][0]["matched_terms"] == ["obsidian", "guessing"]


def test_wiki_recall_endpoint_uses_configured_local_vault(monkeypatch):
    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_build_wiki_recall_context(query, *, vault_root, product, max_results, include_archived):
        return {
            "status": "found",
            "query": query,
            "vault_root": str(vault_root),
            "product": product,
            "max_results": max_results,
            "include_archived": include_archived,
            "answer_policy": "cite_wiki_hits",
            "citations": [{"path": "02_Products/StockVision/決策紀錄_decisions/2026-05-08-memory.md"}],
        }

    import routers.obsidian as obsidian_router

    monkeypatch.setattr(
        obsidian_router,
        "build_wiki_recall_context",
        fake_build_wiki_recall_context,
        raising=False,
    )

    body = asyncio.run(
        recall_wiki_context(
            WikiRecallRequest(
                query="obsidian guessing rule",
                product="StockVision",
                max_results=2,
                include_archived=True,
            )
        )
    )

    assert body["status"] == "found"
    assert body["query"] == "obsidian guessing rule"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["max_results"] == 2
    assert body["include_archived"] is True
    assert body["answer_policy"] == "cite_wiki_hits"
    assert body["citations"][0]["path"].endswith("2026-05-08-memory.md")


def test_wiki_recall_receipt_endpoint_uses_configured_local_vault(monkeypatch):
    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_build_wiki_recall_receipt(query, *, vault_root, product, max_results, include_archived):
        return {
            "status": "receipt",
            "text": "\n".join(
                [
                    "Obsidian recall receipt:",
                    f'- query: "{query}"',
                    "- status: found",
                    "- answer_policy: cite_wiki_hits",
                    "- citations:",
                    "  - 06_MOC/MOC-Home.md",
                ]
            ),
            "vault_root": str(vault_root),
            "product": product,
            "max_results": max_results,
            "include_archived": include_archived,
        }

    import routers.obsidian as obsidian_router

    monkeypatch.setattr(
        obsidian_router,
        "build_wiki_recall_receipt",
        fake_build_wiki_recall_receipt,
        raising=False,
    )

    body = asyncio.run(
        build_wiki_recall_receipt_endpoint(
            WikiRecallRequest(
                query="obsidian receipt",
                product="StockVision",
                max_results=2,
                include_archived=True,
            )
        )
    )

    assert body["status"] == "receipt"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["max_results"] == 2
    assert body["include_archived"] is True
    assert '- query: "obsidian receipt"' in body["text"]
    assert "06_MOC/MOC-Home.md" in body["text"]


def test_wiki_health_endpoint_uses_configured_local_vault(monkeypatch):
    monkeypatch.setitem(os.environ, "OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_inspect_wiki_vault(*, vault_root, product, stale_days, now=None):
        return {
            "status": "ok",
            "vault_root": str(vault_root),
            "product": product,
            "stale_days": stale_days,
            "missing_required": [],
        }

    import routers.obsidian as obsidian_router

    monkeypatch.setattr(obsidian_router, "inspect_wiki_vault", fake_inspect_wiki_vault, raising=False)

    body = asyncio.run(inspect_wiki_health(WikiHealthRequest(product="StockVision", stale_days=5)))

    assert body["status"] == "ok"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["stale_days"] == 5
