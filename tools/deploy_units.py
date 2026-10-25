"""Which production units a change set touches (used by .github/workflows/deploy.yml).

A unit's inputs are its directory (tests excluded), its deploy script, the scheduler manifest that
every provenance record hashes, and each file outside the directory its source reaches through
relative imports (the Worker bundles ml-controller/schemas JSON; the frontend imports worker/src).

Usage: python tools/deploy_units.py <changed-files.txt>   # one repo path per line
Prints `<unit>=true|false` lines for $GITHUB_OUTPUT.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UNITS = {
    'worker': ('worker', 'tools/deploy_worker_with_provenance.mjs'),
    'pages': ('frontend', 'tools/deploy_pages_with_provenance.mjs'),
}
SHARED = {'infra/gcp-scheduler-jobs.json', 'tools/worker_deploy_preflight.mjs'}
SOURCE = {'.ts', '.tsx', '.js', '.mjs'}
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
TEST = re.compile(r'(^|/)(__tests__|tests?)/|\.(test|spec)\.[a-z]+$')


def resolve(importer: Path, specifier: str, root: Path):
    target = importer.parent / specifier
    candidates = [Path(f'{target}{suffix}') for suffix in ('', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx')]
    if specifier.endswith('.js'):
        candidates.insert(0, target.with_suffix('.ts'))
    for path in candidates:
        if path.is_file():
            path = path.resolve()
            return path if path.is_relative_to(root) else None
    return None


def outside_inputs(unit_dir: str, root: Path = ROOT) -> set[str]:
    """Repo paths outside unit_dir that the unit's non-test source reaches."""
    top = (root / unit_dir / 'src').resolve()
    pending = [p.resolve() for p in top.rglob('*')
               if p.is_file() and p.suffix in SOURCE and not TEST.search(p.relative_to(root).as_posix())]
    seen, outside = set(pending), set()
    while pending:
        importer = pending.pop()
        for specifier in SPECIFIER.findall(importer.read_text(encoding='utf-8', errors='replace')):
            found = resolve(importer, specifier, root.resolve())
            if found is None or found in seen:
                continue
            seen.add(found)
            rel = found.relative_to(root.resolve()).as_posix()
            if not rel.startswith(f'{unit_dir}/'):
                outside.add(rel)
            if found.suffix in SOURCE:
                pending.append(found)
    return outside


def touched_units(changed: list[str], root: Path = ROOT) -> dict[str, bool]:
    result = {}
    for unit, (unit_dir, script) in UNITS.items():
        inputs = SHARED | {script} | outside_inputs(unit_dir, root)
        result[unit] = any(
            path in inputs or (path.startswith(f'{unit_dir}/') and not TEST.search(path))
            for path in changed
        )
    return result


if __name__ == '__main__':
    changed = [line.strip() for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines() if line.strip()]
    for unit, hit in touched_units(changed).items():
        print(f'{unit}={str(hit).lower()}')
