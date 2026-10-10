"""Admit only a successful, pinned build of the current canonical Git source."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess


def verify(build, *, image, source_sha, tree_sha, project, service_account):
    prefix = f"asia-east1-docker.pkg.dev/{project}/cloud-run-source-deploy/ml-controller@sha256:"
    if not image.startswith(prefix) or not re.fullmatch(r"[a-f0-9]{64}", image[len(prefix):]):
        raise ValueError("prebuilt_image_scope_invalid")
    if (build.get("status") != "SUCCESS" or build.get("projectId") != project
            or build.get("serviceAccount") != f"projects/{project}/serviceAccounts/{service_account}"):
        raise ValueError("prebuilt_build_identity_invalid")
    substitutions = build.get("substitutions", {})
    if (substitutions.get("_SOURCE_SHA") != source_sha
            or substitutions.get("_SOURCE_TREE_SHA") != tree_sha
            or not re.fullmatch(r"[a-f0-9]{64}", substitutions.get("_SOURCE_CONTEXT_SHA256", ""))):
        raise ValueError("prebuilt_source_identity_mismatch")
    expected_name = image.split("@", 1)[0] + ":" + source_sha
    images = build.get("results", {}).get("images", [])
    if len(images) != 1 or images[0].get("name") != expected_name or images[0].get("digest") != image.split("@", 1)[1]:
        raise ValueError("prebuilt_output_digest_mismatch")
    source = build.get("sourceProvenance", {}).get("resolvedStorageSource", {})
    if not source.get("bucket") or not source.get("object") or not source.get("generation"):
        raise ValueError("prebuilt_source_generation_missing")
    return image


def main():
    parser = argparse.ArgumentParser()
    for name in ("build-id", "image", "source-sha", "tree-sha", "project", "service-account"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9-]{36}", args.build_id):
        parser.error("invalid build ID")
    gcloud = shutil.which("gcloud.cmd") or shutil.which("gcloud")
    raw = subprocess.check_output([gcloud, "builds", "describe", args.build_id,
        "--project=" + args.project, "--region=asia-east1", "--format=json"], timeout=45)
    print(verify(json.loads(raw), image=args.image, source_sha=args.source_sha, tree_sha=args.tree_sha,
        project=args.project, service_account=args.service_account))


if __name__ == "__main__":
    main()
