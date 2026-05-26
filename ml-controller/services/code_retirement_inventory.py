"""Read-only code inventory builder for retirement planning."""

from __future__ import annotations

from pathlib import Path
from typing import Any


SCHEMA_VERSION = "code-retirement-inventory-v1"
DEFAULT_INCLUDE_GLOBS = ("*.py", "*.ts", "*.tsx", "*.sql", "*.md")
DEFAULT_EXCLUDED_DIRS = {
    ".git",
    ".pytest_cache",
    ".tmp",
    ".uv-cache",
    ".venv",
    ".venv-smoke",
    "__pycache__",
    "dist",
    "node_modules",
    "vendor",
}
DEFAULT_CANDIDATE_EXCLUDED_DIRS = DEFAULT_EXCLUDED_DIRS | {"test", "tests", "__tests__"}


def _clean_text(value: object, default: str = "") -> str:
    text = str(value or "").strip()
    return text or default


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _repo_owner(packet: dict[str, Any]) -> str:
    retirement = _as_dict(packet.get("baseline_retirement"))
    return _clean_text(retirement.get("target"), _clean_text(packet.get("baseline_id"), "unknown"))


def _repo_candidate(packet: dict[str, Any]) -> str:
    return _clean_text(packet.get("candidate_id"), "unknown")


def _is_excluded(path: Path, excluded_dirs: set[str]) -> bool:
    return any(part in excluded_dirs for part in path.parts)


def _iter_text_files(root: Path, include_globs: tuple[str, ...], excluded_dirs: set[str]) -> list[Path]:
    seen: set[Path] = set()
    files: list[Path] = []
    for pattern in include_globs:
        for path in root.rglob(pattern):
            if path in seen or not path.is_file():
                continue
            rel = path.relative_to(root)
            if _is_excluded(rel, excluded_dirs):
                continue
            seen.add(path)
            files.append(path)
    return sorted(files, key=lambda p: p.relative_to(root).as_posix())


def _read_text(path: Path, max_file_bytes: int) -> str:
    try:
        if path.stat().st_size > max_file_bytes:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _contains_any_token(path: Path, text: str, tokens: list[str]) -> bool:
    haystacks = [path.as_posix().lower(), text.lower()]
    return any(token.lower() in haystack for token in tokens for haystack in haystacks)


def _resolve_candidate_path(root: Path, raw_path: str) -> tuple[Path | None, str | None]:
    candidate = Path(raw_path)
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        return None, raw_path
    return resolved, None


def _reference_paths(
    *,
    root: Path,
    files: list[Path],
    candidate_path: Path,
    owner_tokens: list[str],
    max_file_bytes: int,
    max_reference_paths: int,
) -> list[str]:
    references: list[str] = []
    for path in files:
        if path == candidate_path:
            continue
        text = _read_text(path, max_file_bytes)
        if any(token.lower() in text.lower() for token in owner_tokens):
            references.append(path.relative_to(root).as_posix())
            if len(references) >= max_reference_paths:
                break
    return references


def build_code_retirement_inventory(
    *,
    adoption_decision_packet: dict[str, Any],
    repo_root: str,
    candidate_paths: list[str] | None = None,
    owner_tokens: list[str] | None = None,
    replacement_owner: str | None = None,
    parallel_readback_passed: bool = False,
    rollback_path: str = "",
    include_globs: tuple[str, ...] = DEFAULT_INCLUDE_GLOBS,
    excluded_dirs: set[str] | None = None,
    max_file_bytes: int = 512_000,
    max_reference_paths: int = 25,
) -> dict[str, Any]:
    packet = _as_dict(adoption_decision_packet)
    root = Path(repo_root).resolve()
    owner = _repo_owner(packet)
    candidate_id = _repo_candidate(packet)
    replacement = _clean_text(replacement_owner, candidate_id)
    tokens = [token for token in (owner_tokens or [owner]) if _clean_text(token)]
    excluded = set(excluded_dirs or DEFAULT_EXCLUDED_DIRS)
    files = _iter_text_files(root, include_globs, excluded)

    skipped_paths: list[str] = []
    candidates: list[Path] = []
    if candidate_paths:
        for raw_path in candidate_paths:
            resolved, skipped = _resolve_candidate_path(root, raw_path)
            if skipped is not None:
                skipped_paths.append(skipped)
                continue
            if resolved is not None and resolved.exists() and resolved.is_file():
                candidates.append(resolved)
    else:
        for path in files:
            rel = path.relative_to(root)
            if _is_excluded(rel, DEFAULT_CANDIDATE_EXCLUDED_DIRS):
                continue
            text = _read_text(path, max_file_bytes)
            if _contains_any_token(rel, text, tokens):
                candidates.append(path)

    deduped_candidates = sorted(set(candidates), key=lambda p: p.relative_to(root).as_posix())
    items: list[dict[str, Any]] = []
    for path in deduped_candidates:
        refs = _reference_paths(
            root=root,
            files=files,
            candidate_path=path,
            owner_tokens=tokens,
            max_file_bytes=max_file_bytes,
            max_reference_paths=max_reference_paths,
        )
        items.append({
            "path": path.relative_to(root).as_posix(),
            "owner": owner,
            "replacement_owner": replacement,
            "parallel_readback_passed": bool(parallel_readback_passed),
            "runtime_references": len(refs),
            "reference_paths": refs,
            "rollback_path": rollback_path,
            "exists": True,
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "retirement_inventory_only",
        "repo_root": str(root),
        "owner": owner,
        "candidate_id": candidate_id,
        "owner_tokens": tokens,
        "items": items,
        "skipped_paths": skipped_paths,
        "summary": {
            "candidate_count": len(items),
            "reference_count": sum(item["runtime_references"] for item in items),
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
    }
