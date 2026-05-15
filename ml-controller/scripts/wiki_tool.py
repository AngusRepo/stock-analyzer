"""Local CLI for Wei-Codex Obsidian wiki retrieval and session drafts."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.wiki_writer import (
    append_moc_links_to_local_vault,
    bootstrap_wiki_vault,
    build_wiki_recall_context,
    build_wiki_recall_receipt,
    inspect_wiki_vault,
    search_wiki_vault,
    write_wiki_note_to_local_vault,
)


DEFAULT_PRODUCT = "StockVision"
SUPPORTED_NOTE_TYPES = [
    "decision",
    "architecture",
    "runbook",
    "research",
    "postmortem",
    "session",
    "source",
    "daily",
    "glossary",
]


def _json_print(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _vault_path(args: argparse.Namespace) -> str:
    vault = (args.vault or os.environ.get("OBSIDIAN_WIKI_VAULT_PATH") or "").strip()
    if not vault:
        raise ValueError("OBSIDIAN_WIKI_VAULT_PATH or --vault is required")
    return vault


def _add_note_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--title", required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--source-ref", action="append", default=[])
    parser.add_argument("--source-file", action="append", default=[])
    parser.add_argument("--related", action="append", default=[])
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--slug")
    parser.add_argument("--now")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--update-moc", action="store_true")
    parser.add_argument("--confirm", action="store_true")


def _write_note_from_args(args: argparse.Namespace, *, vault: str, note_type: str) -> dict[str, Any]:
    payload = {
        "product": args.product,
        "type": note_type,
        "title": args.title,
        "body": args.body,
        "slug": args.slug,
        "source_refs": args.source_ref,
        "source_files": args.source_file,
        "related": args.related,
        "tags": args.tag,
        "status": "draft",
    }
    research_track = getattr(args, "research_track", None)
    if research_track:
        payload["research_track"] = research_track

    result = write_wiki_note_to_local_vault(
        payload,
        vault_root=vault,
        now=args.now,
        overwrite=args.overwrite,
    )
    if args.update_moc:
        result = {
            **result,
            "moc_update": append_moc_links_to_local_vault(result, vault_root=vault),
        }
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search and write Wei-Codex Obsidian wiki notes.")
    parser.add_argument("--vault", help="Local Obsidian vault path. Defaults to OBSIDIAN_WIKI_VAULT_PATH.")
    parser.add_argument("--product", default=DEFAULT_PRODUCT, help="Product namespace to search/write.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search", help="Search wiki notes for memory recovery.")
    search.add_argument("--query", required=True)
    search.add_argument("--max-results", type=int, default=10)
    search.add_argument("--include-archived", action="store_true")

    recall = subparsers.add_parser("recall", help="Build a no-guess wiki memory context pack.")
    recall.add_argument("--query", required=True)
    recall.add_argument("--max-results", type=int, default=5)
    recall.add_argument("--include-archived", action="store_true")

    receipt = subparsers.add_parser("recall-receipt", help="Print a copy-pasteable Obsidian recall receipt.")
    receipt.add_argument("--query", required=True)
    receipt.add_argument("--max-results", type=int, default=5)
    receipt.add_argument("--include-archived", action="store_true")

    doctor = subparsers.add_parser("doctor", help="Inspect wiki structure and recent session activity.")
    doctor.add_argument("--stale-days", type=int, default=3)

    bootstrap = subparsers.add_parser("bootstrap", help="Create the clean Wei-Codex wiki vault skeleton.")
    bootstrap.add_argument("--overwrite", action="store_true")
    bootstrap.add_argument("--confirm", action="store_true")

    note = subparsers.add_parser("note", help="Write a confirmed structured wiki note.")
    note.add_argument("--type", required=True, choices=SUPPORTED_NOTE_TYPES)
    note.add_argument("--research-track")
    _add_note_arguments(note)

    session = subparsers.add_parser("session-draft", help="Write a confirmed session draft note.")
    _add_note_arguments(session)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        vault = _vault_path(args)
        if args.command == "search":
            _json_print(
                search_wiki_vault(
                    args.query,
                    vault_root=vault,
                    product=args.product,
                    max_results=args.max_results,
                    include_archived=args.include_archived,
                )
            )
            return 0

        if args.command == "recall":
            _json_print(
                build_wiki_recall_context(
                    args.query,
                    vault_root=vault,
                    product=args.product,
                    max_results=args.max_results,
                    include_archived=args.include_archived,
                )
            )
            return 0

        if args.command == "recall-receipt":
            result = build_wiki_recall_receipt(
                args.query,
                vault_root=vault,
                product=args.product,
                max_results=args.max_results,
                include_archived=args.include_archived,
            )
            print(result["text"])
            return 0

        if args.command == "doctor":
            _json_print(
                inspect_wiki_vault(
                    vault_root=vault,
                    product=args.product,
                    stale_days=args.stale_days,
                )
            )
            return 0

        if args.command == "bootstrap":
            if not args.confirm:
                print("bootstrap requires --confirm", file=sys.stderr)
                return 2
            _json_print(
                bootstrap_wiki_vault(
                    vault,
                    product=args.product,
                    overwrite=args.overwrite,
                )
            )
            return 0

        if args.command == "note":
            if not args.confirm:
                print("note requires --confirm", file=sys.stderr)
                return 2
            _json_print(_write_note_from_args(args, vault=vault, note_type=args.type))
            return 0

        if args.command == "session-draft":
            if not args.confirm:
                print("session-draft requires --confirm", file=sys.stderr)
                return 2
            _json_print(_write_note_from_args(args, vault=vault, note_type="session"))
            return 0
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2

    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
