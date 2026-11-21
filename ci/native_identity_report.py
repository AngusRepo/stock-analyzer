"""PR check `native-identity`: does this commit still need a re-pin, and is it a reuse or a
new-grant release against the live controller?

usage: native_identity_report.py [<live-sha>]   (default: controller /health; checks HEAD)

Fails only when the commit cannot build as is, so that red means "re-pin needed", not
"identity changed":
- native identity inputs changed after the commit that last changed
  native_execution_behavior_release.json, or
- the allocator / L3 source identities differ from strategy_nav_source_release.json.
"Last changed" is a proxy for "last pinned": a later edit to another manifest field moves it too.
The ci gate's test_exact_running_behavior_release_retains_separate_identity stays the exact check.
reuse / new-grant (release_admission.classify against live) goes to the summary; a re-pinned
new-grant passes with a warning, since it ships through the manual release, not controller CD.
When live cannot be compared (/health down, live commit not fetched) that part is a warning.
Needs the ml-controller requirements (source identities). No credentials.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'release'))

import release  # noqa: E402
import release_admission as admission  # noqa: E402

BEHAVIOR, SOURCES = admission.MANIFEST_PATHS
IDENTITIES = ('allocator_source_identity', 'l3_inference_source_identity')


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True, capture_output=True, text=True).stdout.strip()


def main():
    head = git('rev-parse', 'HEAD')
    pin = git('log', '-1', '--format=%H', head, '--', BEHAVIOR)
    unpinned = admission.native_identity_changes(ROOT, pin, head)
    approved = json.loads((ROOT / SOURCES).read_text(encoding='utf-8'))['approved_sources']
    identities = admission.source_identities(ROOT)
    sources = [name for name in IDENTITIES if identities.get(name) != approved.get(name)]
    repin = bool(unpinned or sources)

    try:
        live = sys.argv[1] if len(sys.argv) > 1 else release.live_controller_sha()
        decision = admission.classify(ROOT, live, head, identities)
    except (Exception, SystemExit) as error:  # infrastructure, not the commit: never red on its own
        live, decision = None, None
        print(f'::warning title=native identity::not compared with the live controller: {error}'[:500])

    mode = decision['mode'] if decision else 'unknown'
    lines = [f'## native identity: ' + ('❌ re-pin needed' if repin else f'✅ {mode}' if decision else '✅ no re-pin needed'), '',
             f'- commit `{head[:8]}`, native pin last set in `{pin[:8]}`',
             f'- release against live `{live[:8]}`: **{mode}**' if decision else '- release against live: not compared']
    lines += [f'  - {r}' for r in (decision or {}).get('reasons', [])]
    if unpinned:
        lines.append(f'- native identity inputs changed since that pin (re-pin `{BEHAVIOR}`): '
                     + ', '.join(f'`{p}`' for p in unpinned[:20]))
    if sources:
        lines.append(f'- {", ".join(sources)} differ from `{SOURCES}` (re-pin it)')
    report = '\n'.join(lines)
    print(report)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as fh:
            fh.write(report + '\n')
    if repin:
        print('::error title=native identity::re-pin needed before this commit can build: '
              + '; '.join(([f'native inputs changed since {pin[:8]}'] if unpinned else []) + sources))
    elif mode == 'new-grant':
        print('::warning title=native identity::new-grant release: controller CD fails closed, use the manual release')
    sys.exit(1 if repin else 0)


if __name__ == '__main__':
    main()
