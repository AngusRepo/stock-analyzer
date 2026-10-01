from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from typing import Any
from urllib.request import Request, urlopen


def release_tag_url(service: dict[str, Any], tag: str, revision: str) -> str:
    matches = [row for row in service.get("status", {}).get("traffic", [])
               if row.get("tag") == tag and row.get("revisionName") == revision]
    if len(matches) != 1 or not str(matches[0].get("url") or "").startswith("https://"):
        raise ValueError("release_tag_revision_missing_or_mismatched")
    return matches[0]["url"]


def verify_traffic(service: dict[str, Any], revision: str) -> None:
    routed = [row for row in service.get("status", {}).get("traffic", [])
              if int(row.get("percent") or 0) > 0]
    if (sum(int(row["percent"]) for row in routed) != 100
            or any(row.get("revisionName") != revision for row in routed)):
        raise ValueError("production_traffic_not_on_exact_release_revision")


def verify_health(payload: dict[str, Any], expected: dict[str, str]) -> None:
    actual = payload.get("provenance") or {}
    if payload.get("status") != "ok" or any(actual.get(key) != value for key, value in expected.items()):
        raise ValueError("http_provenance_mismatch:" + ",".join(
            key for key, value in expected.items() if actual.get(key) != value))


def verify_paper_runtime(payload: dict[str, Any]) -> None:
    if (payload.get('schema_version') != 'canonical-serving-bundle-view-v1'
            or payload.get('status') != 'PASS'
            or payload.get('adoption_basis') != 'paper_experiment_unproven'
            or payload.get('drift_fields') != []
            or payload.get('missing_components') != []
            or payload.get('promotion_authority') is not False
            or payload.get('real_order_writes') != 0):
        raise ValueError('candidate_paper_runtime_unverified')


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify actual Cloud Run release traffic and HTTP provenance")
    parser.add_argument("mode", choices=["tag-url", "traffic", "health", "paper"])
    parser.add_argument("--service")
    parser.add_argument("--region", default="asia-east1")
    parser.add_argument("--revision")
    parser.add_argument("--tag")
    parser.add_argument("--url")
    parser.add_argument("--source-sha")
    parser.add_argument("--tree-sha")
    parser.add_argument("--branch")
    parser.add_argument("--scheduler-sha")
    parser.add_argument("--token-secret")
    args = parser.parse_args()
    if args.mode == 'paper':
        if not args.url or not args.token_secret or ':' not in args.token_secret:
            parser.error('paper URL and controller token secret name:version are required')
        name, version = args.token_secret.rsplit(':', 1)
        gcloud = shutil.which('gcloud.cmd') or shutil.which('gcloud')
        token = subprocess.check_output([gcloud, 'secrets', 'versions', 'access', version,
                                        '--secret=' + name], text=True, encoding='utf-8').strip()
        request = Request(args.url.rstrip('/') + '/research_validation/production_bundle',
                          headers={'X-Controller-Token': token})
        for attempt in range(6):
            try:
                with urlopen(request, timeout=120) as response:
                    verify_paper_runtime(json.load(response))
                print('Cloud Run Paper runtime: exact configuration, no drift, no live authority')
                return
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(5)
        return
    if args.mode in {"tag-url", "traffic"}:
        if not args.service or not args.revision:
            parser.error("service and revision are required")
        gcloud = shutil.which("gcloud.cmd") or shutil.which("gcloud")
        service = json.loads(subprocess.check_output(
            [gcloud, "run", "services", "describe", args.service,
             "--region=" + args.region, "--format=json"], text=True, encoding="utf-8"))
        if args.mode == "tag-url":
            print(release_tag_url(service, args.tag, args.revision))
        else:
            verify_traffic(service, args.revision)
            print("Cloud Run traffic: exact release revision verified")
        return
    expected = {"sourceSha": args.source_sha, "sourceTreeSha": args.tree_sha,
                "sourceBranch": args.branch, "schedulerManifestSha256": args.scheduler_sha}
    if not args.url or any(not value for value in expected.values()):
        parser.error("health URL and all provenance fields are required")
    for attempt in range(6):
        try:
            with urlopen(args.url.rstrip("/") + "/health", timeout=30) as response:
                verify_health(json.load(response), expected)
            print("Cloud Run HTTP provenance: exact source/tree/branch/scheduler verified")
            return
        except Exception:
            if attempt == 5:
                raise
            time.sleep(5)


if __name__ == "__main__":
    main()
