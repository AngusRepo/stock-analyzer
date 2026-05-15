from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import wiki_tool  # noqa: E402


def test_wiki_tool_search_outputs_json(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_search_wiki_vault(query, *, vault_root, product, max_results, include_archived):
        return {
            "status": "searched",
            "query": query,
            "product": product,
            "count": 1,
            "results": [{"path": "06_MOC/MOC-Home.md", "scope": "global_moc"}],
            "vault_root": str(vault_root),
            "max_results": max_results,
            "include_archived": include_archived,
        }

    monkeypatch.setattr(wiki_tool, "search_wiki_vault", fake_search_wiki_vault)

    exit_code = wiki_tool.main(["search", "--query", "obsidian memory", "--max-results", "3"])

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["query"] == "obsidian memory"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["max_results"] == 3
    assert body["results"][0]["scope"] == "global_moc"


def test_wiki_tool_recall_outputs_context_pack(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_build_wiki_recall_context(query, *, vault_root, product, max_results, include_archived):
        return {
            "status": "found",
            "query": query,
            "product": product,
            "answer_policy": "cite_wiki_hits",
            "citations": [{"path": "06_MOC/MOC-Home.md", "wikilink": "[[MOC-Home]]"}],
            "vault_root": str(vault_root),
            "max_results": max_results,
            "include_archived": include_archived,
        }

    monkeypatch.setattr(wiki_tool, "build_wiki_recall_context", fake_build_wiki_recall_context)

    exit_code = wiki_tool.main(["recall", "--query", "obsidian memory", "--max-results", "2"])

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "found"
    assert body["answer_policy"] == "cite_wiki_hits"
    assert body["citations"][0]["wikilink"] == "[[MOC-Home]]"
    assert body["max_results"] == 2


def test_wiki_tool_recall_receipt_outputs_copy_paste_text(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

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
            "max_results": max_results,
            "include_archived": include_archived,
        }

    monkeypatch.setattr(wiki_tool, "build_wiki_recall_receipt", fake_build_wiki_recall_receipt)

    exit_code = wiki_tool.main(["recall-receipt", "--query", "obsidian memory", "--max-results", "2"])

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "Obsidian recall receipt:" in output
    assert '- query: "obsidian memory"' in output
    assert "- answer_policy: cite_wiki_hits" in output
    assert "06_MOC/MOC-Home.md" in output


def test_wiki_tool_session_draft_requires_confirm(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    exit_code = wiki_tool.main(
        [
            "session-draft",
            "--title",
            "Obsidian CLI",
            "--body",
            "Should not write without explicit confirm.",
        ]
    )

    assert exit_code == 2
    assert "requires --confirm" in capsys.readouterr().err


def test_wiki_tool_note_requires_confirm(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    exit_code = wiki_tool.main(
        [
            "note",
            "--type",
            "decision",
            "--title",
            "Obsidian decision",
            "--body",
            "Should not write without explicit confirm.",
        ]
    )

    assert exit_code == 2
    assert "note requires --confirm" in capsys.readouterr().err


def test_wiki_tool_note_writes_generic_note_when_confirmed(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")
    moc_called: list[dict] = []

    def fake_write_wiki_note_to_local_vault(payload, *, vault_root, now=None, overwrite=False):
        return {
            "status": "written",
            "product": payload["product"],
            "type": payload["type"],
            "title": payload["title"],
            "body": payload["body"],
            "research_track": payload.get("research_track"),
            "vault_root": str(vault_root),
            "overwrite": overwrite,
            "files": [{"path": "02_Products/StockVision/研究_research/ML-Intern/2026-05-08-tabm.md"}],
        }

    def fake_append_moc_links_to_local_vault(write_result, *, vault_root):
        moc_called.append(write_result)
        return {"status": "moc_updated", "updated_mocs": [{"path": "MOC.md"}], "unchanged_mocs": []}

    monkeypatch.setattr(wiki_tool, "write_wiki_note_to_local_vault", fake_write_wiki_note_to_local_vault)
    monkeypatch.setattr(wiki_tool, "append_moc_links_to_local_vault", fake_append_moc_links_to_local_vault)

    exit_code = wiki_tool.main(
        [
            "note",
            "--type",
            "research",
            "--research-track",
            "ML-Intern",
            "--title",
            "TabM benchmark",
            "--body",
            "Research note body.",
            "--source-file",
            "ml-controller/services/wiki_writer.py",
            "--related",
            "MOC-ML-Intern",
            "--tag",
            "stockvision/research",
            "--update-moc",
            "--confirm",
        ]
    )

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "written"
    assert body["type"] == "research"
    assert body["research_track"] == "ML-Intern"
    assert body["moc_update"]["updated_mocs"] == [{"path": "MOC.md"}]
    assert moc_called


def test_wiki_tool_session_draft_writes_when_confirmed(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")
    moc_called: list[dict] = []

    def fake_write_wiki_note_to_local_vault(payload, *, vault_root, now=None, overwrite=False):
        return {
            "status": "written",
            "product": payload["product"],
            "type": payload["type"],
            "title": payload["title"],
            "body": payload["body"],
            "vault_root": str(vault_root),
            "overwrite": overwrite,
            "files": [{"path": "02_Products/StockVision/Sessions/2026-05-08-obsidian-cli.draft.md"}],
        }

    def fake_append_moc_links_to_local_vault(write_result, *, vault_root):
        moc_called.append(write_result)
        return {"status": "moc_updated", "updated_mocs": [{"path": "MOC.md"}], "unchanged_mocs": []}

    monkeypatch.setattr(wiki_tool, "write_wiki_note_to_local_vault", fake_write_wiki_note_to_local_vault)
    monkeypatch.setattr(wiki_tool, "append_moc_links_to_local_vault", fake_append_moc_links_to_local_vault)

    exit_code = wiki_tool.main(
        [
            "session-draft",
            "--title",
            "Obsidian CLI",
            "--body",
            "Write a confirmed draft.",
            "--source-file",
            "ml-controller/services/wiki_writer.py",
            "--related",
            "MOC-StockVision",
            "--tag",
            "stockvision/wiki",
            "--update-moc",
            "--confirm",
        ]
    )

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "written"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["type"] == "session"
    assert body["title"] == "Obsidian CLI"
    assert body["moc_update"]["updated_mocs"] == [{"path": "MOC.md"}]
    assert moc_called


def test_wiki_tool_doctor_outputs_health_json(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_inspect_wiki_vault(*, vault_root, product, stale_days, now=None):
        return {
            "status": "ok",
            "vault_root": str(vault_root),
            "product": product,
            "stale_days": stale_days,
            "missing_required": [],
        }

    monkeypatch.setattr(wiki_tool, "inspect_wiki_vault", fake_inspect_wiki_vault)

    exit_code = wiki_tool.main(["doctor", "--stale-days", "5"])

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "ok"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["stale_days"] == 5


def test_wiki_tool_bootstrap_requires_confirm(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    exit_code = wiki_tool.main(["bootstrap"])

    assert exit_code == 2
    assert "bootstrap requires --confirm" in capsys.readouterr().err


def test_wiki_tool_bootstrap_outputs_created_structure(monkeypatch, capsys):
    monkeypatch.setenv("OBSIDIAN_WIKI_VAULT_PATH", "C:/wiki-vault")

    def fake_bootstrap_wiki_vault(vault_root, *, product, overwrite=False):
        return {
            "status": "bootstrapped",
            "vault_root": str(vault_root),
            "product": product,
            "overwrite": overwrite,
            "created_files": ["CLAUDE.md", "06_MOC/MOC-Home.md"],
        }

    monkeypatch.setattr(wiki_tool, "bootstrap_wiki_vault", fake_bootstrap_wiki_vault)

    exit_code = wiki_tool.main(["bootstrap", "--overwrite", "--confirm"])

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "bootstrapped"
    assert body["vault_root"] == "C:/wiki-vault"
    assert body["overwrite"] is True
    assert "CLAUDE.md" in body["created_files"]
