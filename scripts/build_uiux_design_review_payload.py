"""Build a repo-grounded payload for /admin/design-review.

The generated JSON is safe to send to ml-controller: it contains curated UI/UX
code/docs only, not env files or secrets.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_rel(path: str, limit: int = 40_000) -> str:
    text = (ROOT / path).read_text(encoding="utf-8", errors="replace")
    return text if len(text) <= limit else text[:limit] + "\n...[local clip]"


def git_diff(paths: list[str], limit: int = 40_000) -> str:
    proc = subprocess.run(
        ["git", "diff", "--", *paths],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    text = proc.stdout.strip() or "(no diff for selected UI/UX files)"
    return text if len(text) <= limit else text[:limit] + "\n...[local clip]"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    ui_paths = [
        "frontend/src/components/AppShell.tsx",
        "frontend/src/App.tsx",
        "frontend/src/pages/ResearchWorkbenchDemo.tsx",
        "frontend/src/pages/Dashboard.tsx",
        "frontend/src/pages/ObservabilityPage.tsx",
        "frontend/src/pages/PipelinePage.tsx",
    ]

    payload = {
        "objective": (
            "Review StockVision's current UI/UX implementation and propose the next "
            "high-leverage changes for an industrial dark quantitative trading workstation."
        ),
        "focus": [
            "Compare current navigation and information architecture against the Research Workbench direction.",
            "Identify where current pages still feel like generic dashboard UI instead of operator-grade workstation UI.",
            "Prioritize incremental changes that preserve existing routes and API contracts.",
            "Call out copy, density, visual hierarchy, and research-to-decision workflow gaps.",
        ],
        "current_notes": (
            "User wants a Bloomberg/Grafana/VisualHFT-inspired professional terminal feel. "
            "Recent local change grouped navigation into Research / Decision / Operations and "
            "added Research Workbench as a candidate formal entry. ETF was removed from the demo."
        ),
        "artifacts": [
            {
                "name": "Current Chinese UI/UX comparison report",
                "kind": "markdown",
                "content": read_rel("UIUX_CURRENT_STATE_REVIEW_ZH_2026_05_05.md"),
            },
            {
                "name": "Research Workbench implementation plan",
                "kind": "markdown",
                "content": read_rel("UIUX_RESEARCH_WORKBENCH_PLAN_2026_05_05.md"),
            },
            {
                "name": "Current UI/UX working diff",
                "kind": "diff",
                "content": git_diff(ui_paths),
            },
            {
                "name": "AppShell navigation and workstation chrome",
                "kind": "code",
                "content": read_rel("frontend/src/components/AppShell.tsx"),
            },
            {
                "name": "Route map",
                "kind": "route_map",
                "content": read_rel("frontend/src/App.tsx"),
            },
            {
                "name": "Research Workbench demo page",
                "kind": "code",
                "content": read_rel("frontend/src/pages/ResearchWorkbenchDemo.tsx"),
            },
            {
                "name": "Current Dashboard page",
                "kind": "code",
                "content": read_rel("frontend/src/pages/Dashboard.tsx"),
            },
            {
                "name": "OBS and Pipeline reference pages",
                "kind": "code",
                "content": (
                    "===== ObservabilityPage.tsx =====\n"
                    + read_rel("frontend/src/pages/ObservabilityPage.tsx", limit=24_000)
                    + "\n\n===== PipelinePage.tsx =====\n"
                    + read_rel("frontend/src/pages/PipelinePage.tsx", limit=16_000)
                ),
            },
        ],
        "temperature": 0.35,
        "max_output_tokens": 2048,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
