"""Structured Obsidian wiki note builder.

This module is deliberately separate from ``obsidian_writer.py``. The legacy
writer exports trading ops snapshots; this writer builds curated Wei-Codex wiki
notes from explicit payloads and defaults to dry-run output.
"""

from __future__ import annotations

import re
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any


WIKI_NOTE_SCHEMA_VERSION = "wei-codex-wiki-note-v1"
MOC_LINK_MARKER = "<!-- wiki-writer-links -->"

TW_TZ = timezone(timedelta(hours=8))

PRODUCT_ROOTS = {
    "StockVision": "02_Products/StockVision",
}

TYPE_FOLDERS = {
    "decision": "決策紀錄_decisions",
    "architecture": "系統架構_architecture",
    "runbook": "Runbooks",
    "research": "研究_research",
    "postmortem": "Postmortems",
    "session": "Sessions",
    "source": "文章原文_source-articles",
    "daily": "每日文章_daily-articles",
    "glossary": "關鍵字字典_glossary",
}

RESEARCH_TRACK_FOLDERS = {
    "research-intern": "研究_research/Research-Intern",
    "research_intern": "研究_research/Research-Intern",
    "research intern": "研究_research/Research-Intern",
    "research-interns": "研究_research/Research-Intern",
    "research": "研究_research/Research-Intern",
    "Research-Intern": "研究_research/Research-Intern",
    "ML-Intern": "研究_research/ML-Intern",
    "ml-intern": "研究_research/ML-Intern",
    "ml_intern": "研究_research/ML-Intern",
    "ml intern": "研究_research/ML-Intern",
    "model-intern": "研究_research/ML-Intern",
}

MOC_SUGGESTIONS = {
    "StockVision": [
        "06_MOC/MOC-Home.md",
        "02_Products/StockVision/超級連結_moc/MOC-StockVision.md",
    ],
}

SEARCH_SCOPE_TEMPLATES = [
    ("global_moc", "06_MOC"),
    ("global", "01_Global"),
    ("product_moc", "{product_root}/超級連結_moc"),
    ("decisions", "{product_root}/決策紀錄_decisions"),
    ("architecture", "{product_root}/系統架構_architecture"),
    ("runbooks", "{product_root}/Runbooks"),
    ("postmortems", "{product_root}/Postmortems"),
    ("research", "{product_root}/研究_research"),
    ("glossary", "{product_root}/關鍵字字典_glossary"),
    ("source_articles", "{product_root}/文章原文_source-articles"),
    ("daily_articles", "{product_root}/每日文章_daily-articles"),
    ("sessions", "{product_root}/Sessions"),
    ("inbox", "00_Inbox"),
]

REQUIRED_VAULT_PATH_TEMPLATES = [
    "CLAUDE.md",
    "06_MOC/MOC-Home.md",
    "Templates/Session Draft.md",
    "Templates/Decision Note.md",
    "Templates/Research Note.md",
    "{product_root}",
    "{product_root}/超級連結_moc/MOC-StockVision.md",
    "{product_root}/超級連結_moc/MOC-Research-Intern.md",
    "{product_root}/超級連結_moc/MOC-ML-Intern.md",
    "{product_root}/筆記製作規則_note-rules/Wiki Writing Rules.md",
    "{product_root}/決策紀錄_decisions",
    "{product_root}/系統架構_architecture",
    "{product_root}/Runbooks",
    "{product_root}/研究_research",
    "{product_root}/Postmortems",
    "{product_root}/Sessions",
]

BOOTSTRAP_GLOBAL_DIRECTORIES = [
    "00_Inbox",
    "01_Global",
    "02_Products",
    "03_Tooling",
    "04_Research-Library",
    "05_Change-Log",
    "06_MOC",
    "Templates",
    "99_Archive",
]

BOOTSTRAP_PRODUCT_DIRECTORIES = [
    "文章原文_source-articles",
    "每日文章_daily-articles",
    "筆記製作規則_note-rules",
    "超級連結_moc",
    "關鍵字字典_glossary",
    "Change-Log",
    "專案_projects",
    "決策紀錄_decisions",
    "系統架構_architecture",
    "Runbooks",
    "研究_research",
    "研究_research/Research-Intern",
    "研究_research/ML-Intern",
    "Postmortems",
    "Sessions",
    "Ops",
]

SECRET_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(password|passwd|secret|token)\s*=\s*['\"][^'\"]{8,}['\"]"),
]


def _now_iso(now: str | None) -> str:
    return now or datetime.now(TW_TZ).isoformat()


def _date_part(now: str | None) -> str:
    return _now_iso(now)[:10]


def _date_obj(now: str | None) -> datetime.date:
    return datetime.fromisoformat(_now_iso(now).replace("Z", "+00:00")).date()


def _clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clean_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    rows: list[str] = []
    for item in value:
        text = _clean_text(item)
        if text:
            rows.append(text[:500])
    return rows[:50]


def _metadata(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("metadata")
    return value if isinstance(value, dict) else {}


def _slugify(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"[/\\]+", "-", text)
    text = re.sub(r"\.{2,}", "-", text)
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:80] or "untitled"


def _wikilink(value: str) -> str:
    text = value.strip()
    if text.startswith("[[") and text.endswith("]]"):
        return text
    return f"[[{text}]]"


def _note_wikilink(relative_path: str, title: str) -> str:
    note_path = relative_path[:-3] if relative_path.endswith(".md") else relative_path
    return f"[[{note_path}|{title}]]"


def _search_terms(query: str) -> list[str]:
    terms = re.findall(r"[a-z0-9\u4e00-\u9fff]+", query.lower())
    seen: set[str] = set()
    unique: list[str] = []
    for term in terms:
        if term not in seen:
            seen.add(term)
            unique.append(term)
    return unique


def _extract_frontmatter_value(content: str, key: str) -> str:
    if not content.startswith("---"):
        return ""
    end = content.find("\n---", 3)
    if end == -1:
        return ""
    frontmatter = content[3:end].splitlines()
    prefix = f"{key}:"
    for line in frontmatter:
        if line.startswith(prefix):
            return line[len(prefix) :].strip().strip("\"'")
    return ""


def _body_without_frontmatter(content: str) -> str:
    if not content.startswith("---"):
        return content
    end = content.find("\n---", 3)
    if end == -1:
        return content
    return content[end + 4 :].strip()


def _compact_snippet(content: str, terms: list[str], max_length: int = 240) -> str:
    normalized = re.sub(r"\s+", " ", _body_without_frontmatter(content)).strip()
    if not normalized:
        return ""

    lower = normalized.lower()
    first_match = min((lower.find(term) for term in terms if term in lower), default=0)
    start = max(first_match - 80, 0)
    snippet = normalized[start : start + max_length].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if start + max_length < len(normalized):
        snippet = f"{snippet}..."
    return snippet


def _score_content(path: str, title: str, content: str, terms: list[str]) -> tuple[int, list[str]]:
    path_text = path.lower()
    title_text = title.lower()
    content_text = content.lower()
    score = 0
    matched_terms: list[str] = []
    for term in terms:
        term_score = 0
        if term in path_text:
            term_score += 3
        if term in title_text:
            term_score += 5
        term_score += content_text.count(term)
        if term_score:
            matched_terms.append(term)
            score += term_score
    return score, matched_terms


def _search_scopes(product: str) -> list[tuple[str, str]]:
    product_root = PRODUCT_ROOTS[product]
    return [
        (scope, template.format(product_root=product_root))
        for scope, template in SEARCH_SCOPE_TEMPLATES
    ]


def _required_vault_paths(product: str) -> list[str]:
    product_root = PRODUCT_ROOTS[product]
    return [template.format(product_root=product_root) for template in REQUIRED_VAULT_PATH_TEMPLATES]


def _bootstrap_directories(product: str) -> list[str]:
    product_root = PRODUCT_ROOTS[product]
    return [
        *BOOTSTRAP_GLOBAL_DIRECTORIES,
        product_root,
        *[f"{product_root}/{folder}" for folder in BOOTSTRAP_PRODUCT_DIRECTORIES],
    ]


def _bootstrap_file_templates(product: str) -> dict[str, str]:
    product_root = PRODUCT_ROOTS[product]
    return {
        "CLAUDE.md": (
            "# Wei-Codex Wiki Governance\n\n"
            "這個 vault 是 Wei 和 Codex 之間的長期 wiki，不是 snapshot 備份桶。\n\n"
            "## Retrieval Rule\n\n"
            "- 不確定、需要前情提要、或牽涉過去決策時，先查 Obsidian。\n"
            "- Source-of-truth ladder: Obsidian -> repo -> logs/runtime -> unknown。\n"
            "- wiki 沒找到就說 unknown，再查 repo、logs/runtime 或外部文件；不要猜。\n"
            "- live production truth 仍以 repo code、runtime logs、database/API 狀態為準。\n\n"
            "## Observable Recall Receipt\n\n"
            "- 凡是涉及過去決策、偏好、架構、工作流、Obsidian/wiki/memory 的回答，必須先執行 wiki recall。\n"
            "- 回答必須附上 `Obsidian recall receipt`，列出 query、status、answer_policy、citations。\n"
            "- 沒有 receipt 的回答視為未驗證，不可當作已恢復記憶。\n"
            "- 如果 recall status 是 not_found，必須明講 wiki 沒找到相關記憶，再查 repo / logs / runtime。\n\n"
            "## Session Rule\n\n"
            "- 每次重大任務結束，先產生 Sessions/YYYY-MM-DD-topic.draft.md。\n"
            "- 草稿可以保留未完成事項、驗證結果、風險和下一步。\n"
            "- 不把 session draft 當成已批准架構；正式決策要另寫 decision note。\n"
        ),
        "06_MOC/MOC-Home.md": (
            "# MOC-Home\n\n"
            "## Products\n\n"
            f"- [[{product_root}/超級連結_moc/MOC-{product}|{product}]]\n\n"
            "## Linked Notes\n\n"
            f"{MOC_LINK_MARKER}\n"
        ),
        f"{product_root}/超級連結_moc/MOC-{product}.md": (
            f"# MOC-{product}\n\n"
            "## Core\n\n"
            "- [[決策紀錄_decisions]]\n"
            "- [[系統架構_architecture]]\n"
            "- [[Runbooks]]\n"
            "- [[Sessions]]\n\n"
            "## Intern Tracks\n\n"
            "- [[MOC-Research-Intern]]\n"
            "- [[MOC-ML-Intern]]\n\n"
            "## Linked Notes\n\n"
            f"{MOC_LINK_MARKER}\n"
        ),
        f"{product_root}/超級連結_moc/MOC-Research-Intern.md": (
            "# MOC-Research-Intern\n\n"
            "## Scope\n\n"
            "- 資料來源研究\n"
            "- factor hypothesis\n"
            "- paper / article digestion\n\n"
            "## Linked Notes\n\n"
            f"{MOC_LINK_MARKER}\n"
        ),
        f"{product_root}/超級連結_moc/MOC-ML-Intern.md": (
            "# MOC-ML-Intern\n\n"
            "## Scope\n\n"
            "- model experiment notes\n"
            "- benchmark reviews\n"
            "- feature / training diagnostics\n\n"
            "## Linked Notes\n\n"
            f"{MOC_LINK_MARKER}\n"
        ),
        f"{product_root}/筆記製作規則_note-rules/Wiki Writing Rules.md": (
            "# Wiki Writing Rules\n\n"
            "## Core\n\n"
            "- wiki 是 Wei-Codex 長期記憶，不是 snapshot 備份桶。\n"
            "- 每篇 note 要能回答：這是什麼、依據是什麼、未來怎麼找回來。\n"
            "- 涉及不確定前情時，先 recall/search wiki；找不到就說 unknown，再查 repo / logs / runtime。\n"
            "- live production truth 不寫死在 wiki；wiki 只保存 decision、context、runbook、research、postmortem。\n\n"
            "## Recall Receipt Rule\n\n"
            "涉及過去決策、偏好、架構、工作流、Obsidian/wiki/memory 時，回答必須留下：\n\n"
            "```text\n"
            "Obsidian recall receipt:\n"
            "- query: \"...\"\n"
            "- status: found / not_found\n"
            "- answer_policy: cite_wiki_hits / say_unknown_then_check_repo_or_logs\n"
            "- citations:\n"
            "  - path or wikilink\n"
            "```\n\n"
            "沒有 receipt 的回答視為未驗證，不可當作已恢復記憶。\n\n"
            "## Session Draft Rule\n\n"
            "- 每次重大任務結束，寫入 Sessions/YYYY-MM-DD-topic.draft.md。\n"
            "- 草稿必須包含 changed、verification、open risks / next。\n"
            "- draft 不等於正式決策；需要穩定結論時另寫 decision note。\n\n"
            "## Link Rule\n\n"
            "- 優先連到 MOC、decision、architecture、runbook。\n"
            "- source_refs 放外部 URL 或對話來源；source_files 放 repo path。\n"
        ),
        "Templates/Session Draft.md": (
            "---\n"
            "type: session\n"
            "status: draft\n"
            "product: StockVision\n"
            "tags:\n"
            "  - stockvision/session\n"
            "---\n\n"
            "# {{title}}\n\n"
            "## Changed\n\n"
            "- \n\n"
            "## Verification\n\n"
            "- \n\n"
            "## Open Risks\n\n"
            "- \n\n"
            "## Next\n\n"
            "- \n"
        ),
        "Templates/Decision Note.md": (
            "---\n"
            "type: decision\n"
            "status: draft\n"
            "product: StockVision\n"
            "tags:\n"
            "  - stockvision/decision\n"
            "---\n\n"
            "# {{title}}\n\n"
            "## Decision\n\n"
            "- \n\n"
            "## Context\n\n"
            "- \n\n"
            "## Evidence\n\n"
            "- \n\n"
            "## Consequences\n\n"
            "- \n"
        ),
        "Templates/Research Note.md": (
            "---\n"
            "type: research\n"
            "status: draft\n"
            "product: StockVision\n"
            "research_track: Research-Intern\n"
            "tags:\n"
            "  - stockvision/research\n"
            "---\n\n"
            "# {{title}}\n\n"
            "## Question\n\n"
            "- \n\n"
            "## Sources\n\n"
            "- \n\n"
            "## Findings\n\n"
            "- \n\n"
            "## Follow-up\n\n"
            "- \n"
        ),
    }


def _folder_for_note(payload: dict[str, Any], note_type: str) -> str:
    if note_type != "research":
        return TYPE_FOLDERS[note_type]

    metadata = _metadata(payload)
    track = _clean_text(payload.get("research_track")) or _clean_text(metadata.get("research_track"))
    if not track:
        return TYPE_FOLDERS[note_type]
    if track not in RESEARCH_TRACK_FOLDERS:
        raise ValueError(f"unsupported_research_track:{track}")
    return RESEARCH_TRACK_FOLDERS[track]


def _date_from_note_name(path: Path) -> datetime.date | None:
    match = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
    if not match:
        return None
    try:
        return datetime.fromisoformat(match.group(1)).date()
    except ValueError:
        return None


def _reject_secret_like_content(payload: dict[str, Any]) -> None:
    parts = [
        _clean_text(payload.get("title")),
        _clean_text(payload.get("body")),
        "\n".join(_clean_list(payload.get("source_refs"))),
        "\n".join(_clean_list(payload.get("source_files"))),
        "\n".join(_clean_list(payload.get("related"))),
    ]
    haystack = "\n".join(parts)
    for pattern in SECRET_PATTERNS:
        if pattern.search(haystack):
            raise ValueError("secret_like_content")


def _yaml_list(values: list[str], indent: int = 2) -> str:
    pad = " " * indent
    if not values:
        return f"{pad}[]"
    return "\n".join(f"{pad}- {value}" for value in values)


def _frontmatter(
    *,
    note_type: str,
    status: str,
    created: str,
    product: str,
    title: str,
    source_refs: list[str],
    source_files: list[str],
    related: list[str],
    tags: list[str],
) -> str:
    return "\n".join(
        [
            "---",
            f"schema_version: {WIKI_NOTE_SCHEMA_VERSION}",
            f"type: {note_type}",
            f"status: {status}",
            f"created: {created}",
            f"updated: {created}",
            f"product: {product}",
            f"title: {title}",
            "source_refs:",
            _yaml_list(source_refs),
            "source_files:",
            _yaml_list(source_files),
            "related:",
            _yaml_list(related),
            "tags:",
            _yaml_list(tags),
            "---",
        ]
    )


def _build_content(
    *,
    note_type: str,
    status: str,
    created: str,
    product: str,
    title: str,
    body: str,
    source_refs: list[str],
    source_files: list[str],
    related: list[str],
    tags: list[str],
) -> str:
    frontmatter = _frontmatter(
        note_type=note_type,
        status=status,
        created=created,
        product=product,
        title=title,
        source_refs=source_refs,
        source_files=source_files,
        related=related,
        tags=tags,
    )
    related_block = "\n".join(f"- {item}" for item in related) if related else "- None"
    source_ref_block = "\n".join(f"- {item}" for item in source_refs) if source_refs else "- None"
    source_file_block = "\n".join(f"- {item}" for item in source_files) if source_files else "- None"
    return (
        f"{frontmatter}\n\n"
        f"# {title}\n\n"
        f"{body.strip()}\n\n"
        "## Evidence\n\n"
        f"### Source refs\n{source_ref_block}\n\n"
        f"### Source files\n{source_file_block}\n\n"
        "## Related\n\n"
        f"{related_block}\n"
    )


def build_wiki_note_dry_run(payload: dict[str, Any], *, now: str | None = None) -> dict[str, Any]:
    """Build a dry-run file payload for the Wei-Codex wiki.

    The return value is intentionally close to the GitHub tree payload shape,
    but it never writes to disk or GitHub.
    """
    _reject_secret_like_content(payload)

    product = _clean_text(payload.get("product")) or "StockVision"
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")

    note_type = _clean_text(payload.get("type")) or "session"
    if note_type not in TYPE_FOLDERS:
        raise ValueError(f"unsupported_note_type:{note_type}")

    title = _clean_text(payload.get("title"))
    if not title:
        raise ValueError("title_required")

    body = _clean_text(payload.get("body"))
    if not body:
        raise ValueError("body_required")

    created = _date_part(now)
    status = _clean_text(payload.get("status")) or "draft"
    source_refs = _clean_list(payload.get("source_refs"))
    source_files = _clean_list(payload.get("source_files"))
    related = [_wikilink(item) for item in _clean_list(payload.get("related"))]
    tags = _clean_list(payload.get("tags")) or [f"{product.lower()}/{note_type}"]

    slug = _slugify(_clean_text(payload.get("slug")) or title)
    suffix = ".draft.md" if note_type == "session" and status == "draft" else ".md"
    folder = _folder_for_note(payload, note_type)
    path = f"{PRODUCT_ROOTS[product]}/{folder}/{created}-{slug}{suffix}"
    if ".." in path or path.startswith("/") or "\\" in path:
        raise ValueError("unsafe_wiki_path")

    content = _build_content(
        note_type=note_type,
        status=status,
        created=created,
        product=product,
        title=title,
        body=body,
        source_refs=source_refs,
        source_files=source_files,
        related=related,
        tags=tags,
    )

    return {
        "schema_version": WIKI_NOTE_SCHEMA_VERSION,
        "status": "dry_run",
        "product": product,
        "type": note_type,
        "files": [{"path": path, "content": content}],
        "moc_suggestions": MOC_SUGGESTIONS.get(product, ["06_MOC/MOC-Home.md"]),
        "warnings": [],
    }


def _resolve_vault_path(vault_root: str | Path, relative_path: str) -> Path:
    root = Path(vault_root).resolve()
    target = (root / relative_path).resolve()
    if target != root and not target.is_relative_to(root):
        raise ValueError("unsafe_wiki_path")
    return target


def bootstrap_wiki_vault(
    vault_root: str | Path,
    *,
    product: str = "StockVision",
    overwrite: bool = False,
) -> dict[str, Any]:
    """Create the clean Wei-Codex wiki vault skeleton without clobbering notes."""
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")

    root = Path(vault_root).resolve()
    root.mkdir(parents=True, exist_ok=True)

    created_directories: list[str] = []
    unchanged_directories: list[str] = []
    for relative_path in _bootstrap_directories(product):
        target = _resolve_vault_path(root, relative_path)
        if target.exists():
            unchanged_directories.append(relative_path)
            continue
        target.mkdir(parents=True, exist_ok=True)
        created_directories.append(relative_path)

    created_files: list[str] = []
    overwritten_files: list[str] = []
    unchanged_files: list[str] = []
    for relative_path, content in _bootstrap_file_templates(product).items():
        target = _resolve_vault_path(root, relative_path)
        existed = target.exists()
        if existed and not overwrite:
            unchanged_files.append(relative_path)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        if existed and overwrite:
            overwritten_files.append(relative_path)
        else:
            created_files.append(relative_path)

    return {
        "status": "bootstrapped",
        "vault_root": str(root),
        "product": product,
        "created_directories": created_directories,
        "unchanged_directories": unchanged_directories,
        "created_files": created_files,
        "overwritten_files": overwritten_files,
        "unchanged_files": unchanged_files,
    }


def search_wiki_vault(
    query: str,
    *,
    vault_root: str | Path,
    product: str = "StockVision",
    max_results: int = 10,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Search local Obsidian wiki markdown notes for memory recovery."""
    terms = _search_terms(query)
    if not terms:
        raise ValueError("query_required")
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")

    root = Path(vault_root).resolve()
    searched_scopes: list[str] = []
    missing_scopes: list[str] = []
    results: list[dict[str, Any]] = []
    seen_paths: set[str] = set()

    for scope_order, (scope, relative_scope_path) in enumerate(_search_scopes(product)):
        scope_root = _resolve_vault_path(root, relative_scope_path)
        if not scope_root.exists():
            missing_scopes.append(scope)
            continue
        searched_scopes.append(scope)
        for note_path in scope_root.rglob("*.md"):
            if not note_path.is_file():
                continue
            relative_path = note_path.resolve().relative_to(root).as_posix()
            if relative_path in seen_paths:
                continue
            seen_paths.add(relative_path)
            if not include_archived and "/99_Archive/" in f"/{relative_path}/":
                continue
            try:
                content = note_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            title = _extract_frontmatter_value(content, "title") or note_path.stem
            score, matched_terms = _score_content(relative_path, title, content, terms)
            if not score:
                continue

            results.append(
                {
                    "path": relative_path,
                    "wikilink": _note_wikilink(relative_path, title),
                    "title": title,
                    "type": _extract_frontmatter_value(content, "type") or "unknown",
                    "status": _extract_frontmatter_value(content, "status") or "unknown",
                    "scope": scope,
                    "scope_order": scope_order,
                    "score": score,
                    "matched_terms": matched_terms,
                    "snippet": _compact_snippet(content, terms),
                    "source": "local_vault",
                }
            )

    results.sort(key=lambda item: (-item["score"], item["scope_order"], item["path"]))
    capped = max(1, min(max_results, 25))
    results = results[:capped]
    return {
        "status": "searched",
        "query": query,
        "product": product,
        "count": len(results),
        "searched_scopes": searched_scopes,
        "missing_scopes": missing_scopes,
        "results": results,
        "warnings": [],
    }


def build_wiki_recall_context(
    query: str,
    *,
    vault_root: str | Path,
    product: str = "StockVision",
    max_results: int = 5,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Build a no-guess memory context pack from wiki search results."""
    search_result = search_wiki_vault(
        query,
        vault_root=vault_root,
        product=product,
        max_results=max_results,
        include_archived=include_archived,
    )
    citations = [
        {
            "path": item["path"],
            "wikilink": item["wikilink"],
            "title": item["title"],
            "type": item["type"],
            "status": item["status"],
            "scope": item["scope"],
            "matched_terms": item["matched_terms"],
            "snippet": item["snippet"],
        }
        for item in search_result["results"]
    ]
    if not citations:
        return {
            "status": "not_found",
            "query": query,
            "product": product,
            "answer_policy": "say_unknown_then_check_repo_or_logs",
            "message": "wiki 沒找到相關記憶；不要猜，接著查 repo / logs / runtime，仍沒有就回答 unknown。",
            "citations": [],
            "search": search_result,
        }

    return {
        "status": "found",
        "query": query,
        "product": product,
        "answer_policy": "cite_wiki_hits",
        "message": "使用 citations 中的 note path / wikilink / snippet 回答；涉及 live truth 時仍需查 repo / logs / runtime。",
        "citations": citations,
        "search": search_result,
    }


def build_wiki_recall_receipt(
    query: str,
    *,
    vault_root: str | Path,
    product: str = "StockVision",
    max_results: int = 5,
    include_archived: bool = False,
) -> dict[str, Any]:
    """Build a copy-pasteable receipt proving wiki recall was attempted."""
    recall = build_wiki_recall_context(
        query,
        vault_root=vault_root,
        product=product,
        max_results=max_results,
        include_archived=include_archived,
    )
    citation_paths = [item["path"] for item in recall["citations"]]
    citation_lines = [f"  - {path}" for path in citation_paths] or ["  - None"]
    text = "\n".join(
        [
            "Obsidian recall receipt:",
            f'- query: "{query}"',
            f'- status: {recall["status"]}',
            f'- answer_policy: {recall["answer_policy"]}',
            "- citations:",
            *citation_lines,
        ]
    )
    return {
        "status": "receipt",
        "query": query,
        "product": product,
        "text": text,
        "recall": recall,
    }


def _project_hub_relative_path(product: str, title: str, slug: str | None = None) -> str:
    clean_slug = _slugify(_clean_text(slug) or title)
    return f"{PRODUCT_ROOTS[product]}/專案_projects/{clean_slug}.md"


def ensure_project_hub(
    vault_root: str | Path,
    *,
    product: str = "StockVision",
    title: str = "V4 Refactor",
    slug: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Create a project hub note that anchors a large refactor in the wiki."""
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")
    title = _clean_text(title)
    if not title:
        raise ValueError("title_required")

    relative_path = _project_hub_relative_path(product, title, slug)
    target = _resolve_vault_path(vault_root, relative_path)
    if target.exists() and not overwrite:
        return {
            "status": "unchanged",
            "product": product,
            "title": title,
            "path": relative_path,
            "absolute_path": str(target),
        }

    content = "\n".join(
        [
            "---",
            "type: project",
            "status: active",
            f"product: {product}",
            f"title: {title}",
            "tags:",
            "  - stockvision/project",
            "  - stockvision/v4-refactor",
            "---",
            "",
            f"# {title}",
            "",
            "## Purpose",
            "",
            "- Anchor the V4 refactor in the Wei-Codex Obsidian second brain.",
            "- Use Obsidian recall receipt before relying on prior decisions, architecture, workflow, or memory.",
            "",
            "## Boundaries",
            "",
            "- Preserve validated production contracts unless a decision note approves the change.",
            "- Record major architectural choices as decision notes, not only session drafts.",
            "",
            "## Decisions",
            "",
            "- [[決策紀錄_decisions]]",
            "",
            "## Architecture",
            "",
            "- [[系統架構_architecture]]",
            "",
            "## Runbooks",
            "",
            "- [[Runbooks]]",
            "",
            "## Sessions",
            "",
            "- [[Sessions]]",
            "",
            "## Open Questions",
            "",
            "- ",
            "",
        ]
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {
        "status": "written" if not target.exists() or overwrite else "written",
        "product": product,
        "title": title,
        "path": relative_path,
        "absolute_path": str(target),
        "wikilink": _note_wikilink(relative_path, title),
    }


def finish_wiki_task(
    vault_root: str | Path,
    *,
    product: str = "StockVision",
    title: str,
    body: str,
    tags: list[str] | None = None,
    related: list[str] | None = None,
    source_refs: list[str] | None = None,
    source_files: list[str] | None = None,
    now: str | None = None,
    overwrite: bool = False,
    update_moc: bool = True,
    stale_days: int = 3,
) -> dict[str, Any]:
    """Finish a major task with a session draft, optional MOC update, and doctor check."""
    payload = {
        "product": product,
        "type": "session",
        "title": title,
        "body": body,
        "status": "draft",
        "tags": tags or ["stockvision/session"],
        "related": related or ["MOC-StockVision"],
        "source_refs": source_refs or [],
        "source_files": source_files or [],
    }
    write_result = write_wiki_note_to_local_vault(
        payload,
        vault_root=vault_root,
        now=now,
        overwrite=overwrite,
    )
    moc_update = (
        append_moc_links_to_local_vault(write_result, vault_root=vault_root)
        if update_moc
        else {"status": "skipped", "updated_mocs": [], "unchanged_mocs": []}
    )
    health = inspect_wiki_vault(
        vault_root=vault_root,
        product=product,
        stale_days=stale_days,
        now=now,
    )
    return {
        "status": "finished",
        "product": product,
        "title": title,
        "write": write_result,
        "moc_update": moc_update,
        "health": health,
    }


def build_wiki_guard_report(
    vault_root: str | Path,
    *,
    product: str = "StockVision",
    project_slug: str = "v4-refactor",
    stale_days: int = 3,
    query: str | None = None,
    max_results: int = 5,
) -> dict[str, Any]:
    """Preflight wiki state before memory-sensitive refactor work."""
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")

    health = inspect_wiki_vault(vault_root=vault_root, product=product, stale_days=stale_days)
    project_path = f"{PRODUCT_ROOTS[product]}/專案_projects/{_slugify(project_slug)}.md"
    project_target = _resolve_vault_path(vault_root, project_path)
    project_exists = project_target.exists()
    blocking_items: list[str] = []
    if health.get("missing_required"):
        blocking_items.append("missing_required")
    if health.get("is_stale"):
        blocking_items.append("session_stale")
    if not project_exists:
        blocking_items.append("project_hub_missing")

    receipt = None
    if _clean_text(query):
        receipt = build_wiki_recall_receipt(
            query or "",
            vault_root=vault_root,
            product=product,
            max_results=max_results,
        )

    return {
        "status": "ok" if not blocking_items else "blocked",
        "product": product,
        "vault_root": str(Path(vault_root).resolve()),
        "blocking_items": blocking_items,
        "health": health,
        "project_hub": {
            "path": project_path,
            "exists": project_exists,
        },
        "receipt": receipt,
    }


def _git_status_snapshot(repo_cwd: str | Path | None = None) -> dict[str, Any]:
    cwd = Path(repo_cwd or Path.cwd()).resolve()
    try:
        completed = subprocess.run(
            ["git", "status", "--short", "--branch"],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError as e:
        return {
            "status": "error",
            "cwd": str(cwd),
            "branch": None,
            "dirty": None,
            "raw": "",
            "error": str(e),
        }

    raw = completed.stdout.strip()
    lines = raw.splitlines()
    branch_line = lines[0] if lines else ""
    branch = None
    if branch_line.startswith("## "):
        branch = branch_line[3:].split("...", 1)[0].strip() or None

    return {
        "status": "ok" if completed.returncode == 0 else "error",
        "cwd": str(cwd),
        "branch": branch,
        "dirty": any(line.strip() for line in lines[1:]),
        "raw": raw,
        "error": completed.stderr.strip() if completed.returncode else "",
    }


def inspect_graphify_reports(
    vault_root: str | Path,
    *,
    limit: int = 5,
    stale_days: int = 7,
    now: str | None = None,
) -> dict[str, Any]:
    root = Path(vault_root).resolve()
    graphify_root = root / "03_Tooling" / "Graphify"
    if not graphify_root.exists():
        return {
            "status": "not_found",
            "vault_root": str(root),
            "count": 0,
            "limit": limit,
            "stale_days": stale_days,
            "age_days": None,
            "is_stale": None,
            "warnings": ["graphify_report_missing"],
            "latest_report": None,
            "reports": [],
        }

    reports = [path for path in graphify_root.rglob("GRAPH_REPORT.md") if path.is_file()]
    if not reports:
        return {
            "status": "not_found",
            "vault_root": str(root),
            "count": 0,
            "limit": limit,
            "stale_days": stale_days,
            "age_days": None,
            "is_stale": None,
            "warnings": ["graphify_report_missing"],
            "latest_report": None,
            "reports": [],
        }

    sorted_reports = sorted(reports, key=lambda path: (path.stat().st_mtime_ns, str(path)), reverse=True)
    report_items = [_graphify_report_item(path, root) for path in sorted_reports[: max(1, limit)]]
    now_dt = datetime.fromisoformat(_now_iso(now).replace("Z", "+00:00"))
    modified_dt = datetime.fromisoformat(report_items[0]["modified_at"])
    age_days = max(0, (now_dt - modified_dt).days)
    is_stale = age_days > stale_days
    return {
        "status": "found",
        "vault_root": str(root),
        "count": len(reports),
        "limit": limit,
        "stale_days": stale_days,
        "age_days": age_days,
        "is_stale": is_stale,
        "warnings": ["graphify_report_stale"] if is_stale else [],
        "latest_report": report_items[0],
        "reports": report_items,
    }


def _graphify_report_item(path: Path, root: Path) -> dict[str, Any]:
    summary_lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip()
    ][:12]
    return {
        "path": path.relative_to(root).as_posix(),
        "absolute_path": str(path),
        "summary": summary_lines,
        "modified_at": datetime.fromtimestamp(path.stat().st_mtime, tz=TW_TZ).isoformat(),
    }


def build_wiki_start_task_context(
    vault_root: str | Path,
    *,
    product: str = "StockVision",
    project_slug: str = "v4-refactor",
    query: str,
    repo_cwd: str | Path | None = None,
    stale_days: int = 3,
    max_results: int = 5,
) -> dict[str, Any]:
    """Bundle wiki preflight, recall proof, and git status for a new task."""
    guard = build_wiki_guard_report(
        vault_root,
        product=product,
        project_slug=project_slug,
        stale_days=stale_days,
        query=query,
        max_results=max_results,
    )
    git = _git_status_snapshot(repo_cwd)
    graphify = inspect_graphify_reports(vault_root, limit=1, stale_days=stale_days)
    ready = guard["status"] == "ok"
    next_actions = (
        ["Proceed with the task using receipt citations for prior-context claims."]
        if ready
        else ["Resolve guard blocking_items before starting memory-sensitive work."]
    )
    if graphify["status"] == "found":
        latest_report = graphify["latest_report"]
        next_actions.insert(
            0,
            f"Read the latest Graphify report before architecture navigation: {latest_report['path']}",
        )
        if graphify.get("is_stale"):
            next_actions.insert(
                0,
                "Refresh the Graphify report before relying on graph navigation; current report is stale.",
            )
    return {
        "status": "ready" if ready else "blocked",
        "product": product,
        "project_slug": project_slug,
        "query": query,
        "vault_root": str(Path(vault_root).resolve()),
        "guard": guard,
        "git": git,
        "graphify": graphify,
        "next_actions": next_actions,
    }


def inspect_wiki_vault(
    *,
    vault_root: str | Path,
    product: str = "StockVision",
    stale_days: int = 3,
    now: str | None = None,
) -> dict[str, Any]:
    """Inspect local wiki structure and recent session activity."""
    if product not in PRODUCT_ROOTS:
        raise ValueError(f"unsupported_product:{product}")

    root = Path(vault_root).resolve()
    missing_required = [
        relative_path
        for relative_path in _required_vault_paths(product)
        if not _resolve_vault_path(root, relative_path).exists()
    ]

    note_counts: dict[str, int] = {}
    for scope, relative_scope_path in _search_scopes(product):
        scope_root = _resolve_vault_path(root, relative_scope_path)
        if not scope_root.exists():
            note_counts[scope] = 0
            continue
        note_counts[scope] = sum(1 for note_path in scope_root.rglob("*.md") if note_path.is_file())

    sessions_root = _resolve_vault_path(root, f"{PRODUCT_ROOTS[product]}/Sessions")
    session_notes = []
    if sessions_root.exists():
        for note_path in sessions_root.rglob("*.md"):
            note_date = _date_from_note_name(note_path)
            if note_path.is_file() and note_date is not None:
                try:
                    modified_at = note_path.stat().st_mtime
                except OSError:
                    modified_at = 0.0
                session_notes.append((note_date, modified_at, note_path))

    latest_session: dict[str, Any] | None = None
    is_stale = True
    if session_notes:
        latest_date, _, latest_path = max(session_notes, key=lambda item: (item[0], item[1], str(item[2])))
        days_since = (_date_obj(now) - latest_date).days
        is_stale = days_since > stale_days
        latest_session = {
            "path": latest_path.resolve().relative_to(root).as_posix(),
            "date": latest_date.isoformat(),
            "days_since": days_since,
        }

    status = "ok" if not missing_required and not is_stale else "degraded"
    return {
        "status": status,
        "vault_root": str(root),
        "product": product,
        "stale_days": stale_days,
        "missing_required": missing_required,
        "note_counts": note_counts,
        "latest_session": latest_session,
        "is_stale": is_stale,
        "warnings": [],
    }


def write_wiki_note_to_local_vault(
    payload: dict[str, Any],
    *,
    vault_root: str | Path,
    now: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Write a confirmed wiki note into a local Obsidian vault."""
    preview = build_wiki_note_dry_run(payload, now=now)
    written_files: list[dict[str, str]] = []

    for file_info in preview["files"]:
        relative_path = file_info["path"]
        target = _resolve_vault_path(vault_root, relative_path)
        if target.exists() and not overwrite:
            raise ValueError(f"wiki_note_exists:{relative_path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file_info["content"], encoding="utf-8")
        written_files.append(
            {
                "path": relative_path,
                "absolute_path": str(target),
                "title": _extract_frontmatter_value(file_info["content"], "title") or Path(relative_path).stem,
                "wikilink": _note_wikilink(
                    relative_path,
                    _extract_frontmatter_value(file_info["content"], "title") or Path(relative_path).stem,
                ),
            }
        )

    return {
        **preview,
        "status": "written",
        "files": written_files,
    }


def append_moc_links_to_local_vault(
    write_result: dict[str, Any],
    *,
    vault_root: str | Path,
) -> dict[str, Any]:
    """Append written note links to suggested MOC files without duplicating links."""
    moc_paths = _clean_list(write_result.get("moc_suggestions"))
    note_links = [
        _clean_text(file_info.get("wikilink"))
        for file_info in write_result.get("files", [])
        if isinstance(file_info, dict) and _clean_text(file_info.get("wikilink"))
    ]
    if not moc_paths or not note_links:
        return {"status": "moc_updated", "updated_mocs": [], "unchanged_mocs": moc_paths}

    updated_mocs: list[dict[str, Any]] = []
    unchanged_mocs: list[str] = []

    for moc_path in moc_paths:
        target = _resolve_vault_path(vault_root, moc_path)
        if target.exists():
            content = target.read_text(encoding="utf-8", errors="ignore")
        else:
            content = f"# {target.stem}\n\n## Linked Notes\n\n{MOC_LINK_MARKER}\n"

        if MOC_LINK_MARKER not in content:
            content = f"{content.rstrip()}\n\n## Linked Notes\n\n{MOC_LINK_MARKER}\n"

        added_links: list[str] = []
        for link in note_links:
            if link not in content:
                content = f"{content.rstrip()}\n- {link}\n"
                added_links.append(link)

        if added_links:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            updated_mocs.append({"path": moc_path, "added_links": added_links})
        else:
            unchanged_mocs.append(moc_path)

    return {
        "status": "moc_updated",
        "updated_mocs": updated_mocs,
        "unchanged_mocs": unchanged_mocs,
    }
