"""R33 serving-parity check: prove the R33 branch does not change daily Modal inference.

Read-only, local CPU. Two parts:

1. static  - every top-level def/class/constant that differs from the base commit in
             ml-service/app/*.py or modal_app.py, intersected with an import-resolved
             (module, top-level symbol) call graph rooted at the daily inference
             entrypoints of modal_app (union of base and branch edges; any reference in
             a body is an edge). Anything reachable must be covered by part 2.
2. dynamic - runs the reachable shared code of base and of this tree in two separate
             interpreters on the same frozen inputs (production rosters/profiles, every
             window of a production OOF manifest read from GCS, prep request defaults)
             and asserts identical output. Reachable changes that need FinLab/D1 inputs
             are listed under proven_by_code with their file:line argument.

Usage (from the repo root):
  python ml-service/scripts/r33_serving_parity.py --base 201cb5594 [--manifest gs-path] [--json out.json]
Exit code 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVICE = REPO / "ml-service"

# Daily serving entrypoints (Modal functions the Worker/controller call for inference).
INFERENCE_ENTRYPOINTS = (
    "predict_single_stock", "predict_batch_v2", "pipeline_prediction_bundle",
    "_compute_pipeline_prediction_bundle", "_pipeline_prediction_bundle_impl",
    "gnn_graphsage_universal_predict", "dlinear_universal_predict", "patchtst_universal_predict",
    "itransformer_universal_predict", "timesfm_universal_predict", "state_space_universal_predict",
    "timexer_universal_predict", "l4_native_prediction",
    # Serving inputs: daily inference_only feature prep, canonical adjusted prep and the
    # frozen forward-extension shadow inference; the ASGI app (warmup/health/IC routes).
    "prep_universal_batch", "prep_universal_batch_event", "rebuild_canonical_adjusted_prep",
    "rebuild_canonical_adjusted_prep_event", "build_frozen_oof_forward_extension",
    "build_frozen_oof_forward_extension_gpu", "fastapi_app",
)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout


def changed_python_files(base: str) -> list[str]:
    names = set(git("diff", "--name-only", base, "--", "ml-service/app", "ml-service/modal_app.py").split())
    names |= {n for n in git("ls-files", "--others", "--exclude-standard", "ml-service/app").split()}
    return sorted(n for n in names if n.endswith(".py"))


def top_level(source: str) -> dict[str, str]:
    out = {}
    for node in ast.parse(source.lstrip("﻿")).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.name] = ast.dump(node, include_attributes=False)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                for name in ast.walk(target):
                    if isinstance(name, ast.Name):
                        out[name.id] = ast.dump(node, include_attributes=False)
    return out


def changed_symbols(base: str) -> dict[str, list[dict]]:
    result = {}
    for rel in changed_python_files(base):
        try:
            old = top_level(git("show", f"{base}:{rel}"))
        except subprocess.CalledProcessError:
            old = {}
        path = REPO / rel
        new = top_level(path.read_text(encoding="utf-8")) if path.exists() else {}
        rows = []
        for name in sorted(set(old) | set(new)):
            if old.get(name) != new.get(name):
                rows.append({"symbol": name, "kind": "added" if name not in old else "removed" if name not in new else "modified"})
        if rows:
            result[rel] = rows
    return result


def module_name(root: Path, path: Path) -> str:
    parts = list(path.relative_to(root).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _import_target(module: str, is_package: bool, node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    package = module.split(".") if is_package else module.split(".")[:-1]
    package = package[: len(package) - (node.level - 1)]
    return ".".join([*package, *([node.module] if node.module else [])])


def _aliases(module: str, is_package: bool, nodes, modules: set[str]) -> dict:
    """local name -> (module, symbol), or (module, None) when the name is a module alias."""
    out = {}
    for node in nodes:
        if isinstance(node, ast.ImportFrom):
            target = _import_target(module, is_package, node)
            for alias in node.names:
                full = f"{target}.{alias.name}" if target else alias.name
                out[alias.asname or alias.name] = (full, None) if full in modules else (target, alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in modules:
                    out[alias.asname or alias.name.split(".")[0]] = (alias.name, None)
    return out


def call_graph(root: Path) -> dict[tuple[str, str], set[tuple[str, str]]]:
    """(module, top-level symbol) -> referenced (module, symbol), resolved through imports.

    Nested functions/methods count as their enclosing top-level symbol, so any reference
    anywhere in a body is an edge: over-approximating inside a module, but free of the
    cross-module name collisions of a purely name-based graph."""
    parsed = {}
    for path in [root / "modal_app.py", *sorted((root / "app").rglob("*.py"))]:
        parsed[module_name(root, path)] = (path.name == "__init__.py",
                                           ast.parse(path.read_text(encoding="utf-8-sig")))
    modules = set(parsed)
    graph: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for mod, (is_package, tree) in parsed.items():
        own = set(top_level(ast.unparse(tree)))
        imports = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
        module_aliases = _aliases(mod, is_package, imports, modules)
        for alias, target in module_aliases.items():  # re-exports resolve to their source
            if target[1]:
                graph.setdefault((mod, alias), set()).add(target)
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = [n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)]
            else:
                continue
            local_imports = [n for n in ast.walk(node) if isinstance(n, (ast.Import, ast.ImportFrom))]
            local = {**module_aliases, **_aliases(mod, is_package, local_imports, modules)}
            refs: set[tuple[str, str]] = set()
            for sub in ast.walk(node):
                if isinstance(sub, ast.Name):
                    if sub.id in own:
                        refs.add((mod, sub.id))
                    target = local.get(sub.id)
                    if target and target[1]:
                        refs.add(target)
                elif isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
                    target = local.get(sub.value.id)
                    if target and target[1] is None:
                        refs.add((target[0], sub.attr))
            for name in names:
                graph.setdefault((mod, name), set()).update(refs)
    return graph


def reachable(graph, roots):
    """Reachable nodes plus a parent map for witness paths."""
    seen, stack, parent = set(), list(roots), {root: None for root in roots}
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        for nxt in graph.get(node, ()):
            parent.setdefault(nxt, node)
            stack.append(nxt)
    return seen, parent


def witness(parent, node) -> list[str]:
    path = []
    while node is not None:
        path.append(".".join(node))
        node = parent.get(node)
    return path


# --------------------------------------------------------------------------- dynamic
DYNAMIC_PROBE = r'''
import json, sys, hashlib
sys.path.insert(0, sys.argv[1])
inputs = json.loads(open(sys.argv[2], encoding="utf-8").read())
out = {}
from app import alpha_model_roster as roster, formal_feature_contract as ffc
for names in inputs["rosters"]:
    for complete in (False, True):
        try: out[f"model_order:{','.join(names)}:{complete}"] = list(roster.model_order(names, complete=complete))
        except Exception as e: out[f"model_order:{','.join(names)}:{complete}"] = "error:" + str(e)
    try: out[f"validate_order:{','.join(names)}"] = list(roster.validate_order(names))
    except Exception as e: out[f"validate_order:{','.join(names)}"] = "error:" + str(e)
for profile in inputs["profiles"]:
    out[f"profile131:{profile}"] = profile in ffc.PROFILES131
out["FEATURES131"] = hashlib.sha256(json.dumps(list(ffc.FEATURES131)).encode()).hexdigest()
from app.oof_forward_source_contract import assess_fold_forward_sources
class Blob:
    def __init__(self, name): self.name = name
    def exists(self): return True
class Bucket:
    def blob(self, name): return Blob(name)
for window in inputs["windows"]:
    out[f"assess:{window.get('window_id')}"] = assess_fold_forward_sources(
        window, cohort_id=inputs["cohort_id"], bucket=Bucket(), manifest=inputs["manifest"])
from app import universal_training as ut
req = ut.UniversalPrepRequest(**inputs["prep_request"])
out["prep_request"] = req.model_dump()
out["prep_request"].pop("feature_warmup_rows", None)  # new field, default 0; behavior checked below
out["prep_warmup_noop"] = getattr(req, "feature_warmup_rows", 0) == 0
out["prep_pit_contract_none"] = (out["prep_request"].pop("pit_contract_version", None) is None
                                 and out["prep_request"].pop("pit_contract_sha256", None) is None)
# C28-02: payloads without pit_contract_version keep the feature layer byte-identical.
from app.features import build_feature_matrix
fx = inputs["feature_fixture"]
for variant, prices in (("", fx["prices"]), ("dense_avg_price:", fx["prices_dense_avg"])):
    for historical in (False, True):
        df = build_feature_matrix(prices, fx["indicators"], fx["chips"], [], fx["market_env"],
                                  historical_training=historical)
        out[f"features:{variant}historical={historical}"] = hashlib.sha256(df.write_csv().encode()).hexdigest()
from app import schemas, batch_prediction
predict = schemas.PredictRequest(stock_id=1, symbol="2330", prices=fx["prices"], indicators=fx["indicators"],
                                 chips=fx["chips"], market_env=fx["market_env"])
out["predict_pit_contract_none"] = getattr(predict, "pit_contract_version", None) is None
ctx = batch_prediction._build_feature_batch_context(predict)
out["serving_latest_features"] = [hashlib.sha256(ctx.x_latest.tobytes()).hexdigest(), list(ctx.feature_names)]
# An artifact without a recorded contract version aligns exactly as before (serving guard).
aligned = batch_prediction._align_latest_features(ctx, {"feature_names": list(ctx.feature_names)[1:], "feature_medians": {}})
out["serving_aligned_features"] = hashlib.sha256(aligned.tobytes()).hexdigest()
# Production-shaped metadata nests scopes, lineage and fold lists; none records a contract version.
nested = {"feature_names": list(ctx.feature_names)[1:], "feature_medians": {},
          "input_scope": {"scope": "explicit_full_fit_samples", "point_in_time_vintage_certified": False},
          "dataset_snapshot": {"prep_lineage": {"manifest_checksum": "a" * 64, "batches": [{"rows": 1}]}},
          "selection_evidence": {"folds": [{"window_id": 0, "selected": ["KMID"]}]}}
aligned = batch_prediction._align_latest_features(ctx, nested)
out["serving_aligned_features:nested_metadata"] = hashlib.sha256(aligned.tobytes()).hexdigest()
from app import canonical_adjusted_prep as cap
import numpy as np
batch = {"symbols": np.array(fx["venue_symbols"]), "markets": np.array(fx["venue_markets"])}
if hasattr(cap, "_row_markets"):
    out["label_markets"] = list(cap._row_markets(batch["markets"]))
else:
    venues = cap._market_map([batch])
    out["label_markets"] = [venues.get(s, "") for s in batch["symbols"].astype(str)]
print(json.dumps(out, sort_keys=True, default=str))
'''


def feature_fixture(rows: int = 300) -> dict:
    """Frozen serving-shaped inputs that exercise every C28-02 branch in the feature layer:
    margin/short chips, dated revenue/eps history, same-day serving scalars, indicator
    columns that appear only part-way through (the vmd whole-column check, PIT-P0 7, and
    parabolicSar) and avg_price both sparse and on every row (the VWAP fallback)."""
    from datetime import date, timedelta
    days = [d for d in (date(2025, 6, 2) + timedelta(days=i) for i in range(rows * 2)) if d.weekday() < 5][:rows]
    prices = [{"date": str(d), "open": 100 + (i % 7), "high": 103 + (i % 5), "low": 97 + (i % 3),
               "close": 100 + (i % 11) * .5, "adj_close": 99 + (i % 11) * .5, "volume": 1000 + 37 * (i % 13)}
              for i, d in enumerate(days)]
    dense = [{**row, "avg_price": row["close"] - .25} for row in prices]
    prices = [{**row, "avg_price": row["close"] + .25} if i > rows // 3 and i % 4 == 0 else row
              for i, row in enumerate(prices)]
    indicators = [{"date": str(d), "CORD_10": ((i * 7) % 11) / 10,
                   **({"volumeMomentumDivergence132710": ((i * 3) % 7) / 5} if i > rows // 2 and i % 9 else {}),
                   **({"parabolicSar": 99.0 + (i % 5)} if i > rows // 4 and i % 5 else {})}
                  for i, d in enumerate(days)]
    chips = [{"date": str(d), "foreign_net": float((i * 13) % 17 - 8), "margin_balance": 5000.0 + i,
              "short_balance": 300.0 + (i % 6)} for i, d in enumerate(days)]
    history = {str(d): {"revenue": 1e5 + i, "revenue_yoy": .1, "eps": 2.0 + i / 100} for i, d in enumerate(days) if i % 21 == 3}
    return {"prices": prices, "prices_dense_avg": dense, "indicators": indicators, "chips": chips,
            "market_env": {"per_stock_ts": history, "eps": 9.5, "revenue": 8e5, "margin_balance": 4e3, "pe": 12.0},
            # Daily inference never sends market_since, so every symbol keeps one venue.
            "venue_symbols": ["2330", "2330", "8069", "6467"], "venue_markets": ["TWSE", "TWSE", "TPEX", "TWSE"]}


def export_tree(rev: str | None, dest: Path) -> Path:
    if rev is None:
        return SERVICE
    import io
    import tarfile
    archive = subprocess.run(["git", "-C", str(REPO), "archive", rev, "ml-service/app", "ml-service/modal_app.py",
                              "data/feature_registry"],
                             check=True, capture_output=True).stdout
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(dest, filter="data")
    return dest / "ml-service"


def load_manifest(manifest: str | None) -> dict:
    if not manifest:
        return {}
    from google.cloud import storage  # read-only download
    bucket_name, _, blob = manifest.removeprefix("gs://").partition("/")
    return json.loads(storage.Client().bucket(bucket_name).blob(blob).download_as_bytes())


def run_dynamic(base: str, manifest: str | None) -> dict:
    from app.alpha_model_roster import LEGACY_MODELS, TIMEXER_MODELS
    from app.formal_feature_contract import EXO131_PROFILE, PRICE131_PROFILE
    production = load_manifest(manifest)
    inputs = {
        "rosters": [list(LEGACY_MODELS), list(TIMEXER_MODELS), list(reversed(TIMEXER_MODELS)),
                    [m for m in TIMEXER_MODELS if m != "GNN"]],
        "profiles": [EXO131_PROFILE, PRICE131_PROFILE, "active8-release-model-profiles-v4-timexer-exo137"],
        "windows": list(production.get("windows") or []),
        "cohort_id": production.get("cohort_id") or "",
        "manifest": production,
        "prep_request": {"payloads": []},
        "feature_fixture": feature_fixture(),
    }
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "inputs.json").write_text(json.dumps(inputs), encoding="utf-8")
        (tmp / "probe.py").write_text(DYNAMIC_PROBE, encoding="utf-8")
        results = {}
        for label, rev in (("base", base), ("branch", None)):
            root = export_tree(rev, tmp / label if rev else tmp)
            env = {**os.environ, "PYTHONUTF8": "1"}
            proc = subprocess.run([sys.executable, "-I", str(tmp / "probe.py"), str(root), str(tmp / "inputs.json")],
                                  capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(tmp))
            if proc.returncode:
                raise RuntimeError(f"{label} probe failed: {proc.stderr[-2000:]}")
            results[label] = json.loads(proc.stdout.strip().splitlines()[-1])
    diffs = sorted(k for k in set(results["base"]) | set(results["branch"])
                   if results["base"].get(k) != results["branch"].get(k))
    return {"checks": len(results["branch"]), "windows_checked": len(inputs["windows"]),
            "differences": diffs,
            "status": "pass" if not diffs and all(results["branch"][k] for k in (
                "prep_warmup_noop", "prep_pit_contract_none", "predict_pit_contract_none")) else "fail",
            "sha256": {k: hashlib.sha256(json.dumps(v, sort_keys=True, default=str).encode()).hexdigest()
                       for k, v in results.items()}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="201cb5594")
    parser.add_argument("--manifest", default="", help="gs://bucket/path of a production OOF manifest (read-only)")
    parser.add_argument("--json", default="")
    args = parser.parse_args()
    sys.path.insert(0, str(SERVICE))

    changed = changed_symbols(args.base)
    roots = [("modal_app", name) for name in INFERENCE_ENTRYPOINTS]
    # Union of both trees' edges: a symbol reachable from inference in either revision counts.
    graph = call_graph(SERVICE)
    for node, refs in call_graph(export_tree(args.base, Path(tempfile.mkdtemp()))).items():
        graph.setdefault(node, set()).update(refs)
    live, parent = reachable(graph, roots)
    reachable_changes = []
    for rel, rows in changed.items():
        module = module_name(SERVICE, REPO / rel)
        for row in rows:
            if (module, row["symbol"]) in live:
                reachable_changes.append({"file": rel, **row, "path": witness(parent, (module, row["symbol"]))})
    static = {"changed": changed, "reachable_from_inference": reachable_changes,
              "entrypoints": list(INFERENCE_ENTRYPOINTS)}
    dynamic = run_dynamic(args.base, args.manifest or None)
    covered = {"model_order", "validate_order", "PROFILES131", "R33_PROFILE", "R33_MODELS",
               "assess_fold_forward_sources", "UniversalPrepRequest",
               # C28-02, executed by the probe without pit_contract_version / market_since.
               "build_feature_matrix", "PredictRequest", "_build_feature_batch_context",
               "_market_map", "_row_markets", "RANKED_MARKETS", "_align_latest_features",
               "artifact_contract_version", "feature_missing_masks", "_artifact_pit_version", "_PIT_VERSION_SLOT",
               # The context records the version the probe built features with (None) and the guard reads it.
               "_FeatureBatchContext"}
    r33_only = ("The controller sets it only when r33_prep = prep_only and not inference_only and profile == R33 "
                "(ml-controller/routers/retrain_trigger.py:1497, :1936, :2072, :2109), so daily inference_only "
                "prep never sees it.")
    # Reachable but proven inert for serving by code (not executed: needs FinLab/D1 inputs).
    proven = {"prep_universal_batch": (
        "ml-service/app/universal_training.py:790-792 slices rows only when req.feature_warmup_rows is truthy; "
        "default 0 at :87 (probe prep_warmup_noop). pit_contract_version and pit_contract_sha256 default None at "
        ":88-89 (probe prep_pit_contract_none); a sha without a version is refused and the contract is loaded and checked (:721-729) "
        "and forwarded (:763/:894-896) only when pit_contract_version is not None; market_since changes _market only when the "
        "payload carries it (:776-780). " + r33_only),
        "rebuild_canonical_adjusted_prep": (
        "ml-service/app/canonical_adjusted_prep.py:287 labels each row by its own market; with one venue per "
        "symbol that equals the old _market_map mode (probe label_markets). Rows differ only when the source prep "
        "carries a per-row UNKNOWN venue, written only from market_since, or when a legacy source prep lists one "
        "symbol under two ranked venues (the old mode gave all its rows one venue; per-row labels keep each row's "
        "own). Canonical prep is training input, not a serving path. The manifest gains pit_contract_version "
        "(:369-370) only when the source receipt has it. " + r33_only)}
    # The TimeXer and frozen-forward guards compare versions that only R33 preps and receipts write.
    guard = ("compares the artifact's recorded pit_contract_version (artifact_contract_version; no pre-C28-02 "
             "artifact records one) with the feature receipt's or prep manifest's pit_contract_version, which only "
             "R33 preps write. Legacy artifacts on legacy preps compare None == None and run unchanged; a mismatch "
             "raises before any weight read (tests test_timexer_feature_receipt, test_timexer_identity_boundary, "
             "test_feature_alignment_precision). ")
    proven.update({
        "batch_predict": "ml-service/app/timexer_inference.py:101-103 " + guard + r33_only,
        "predict_forward": "ml-service/app/timexer_forward.py:28-31 " + guard + r33_only,
        "_align_features": "ml-service/app/oof_forward_extension.py:166-169 " + guard + r33_only,
        "build_frozen_forward_extension": "ml-service/app/oof_forward_extension.py:282-283 " + guard + r33_only})
    # pit_contract runs only when a caller passes pit_contract_version (features/__init__.py:214-217).
    proven.update({name: "ml-service/app/features/__init__.py:214-217 calls app.pit_contract only when "
                         "pit_contract_version is not None; PredictRequest defaults it to None (probe "
                         "predict_pit_contract_none) and the Worker does not send it."
                   for name in ("CONTRACT_VERSION", "_FILES", "load", "feature_lags", "_FEATURE_LAGS_SHA256",
                                "feature_windows", "_WINDOW_FILES", "_FEATURE_WINDOWS_SHA256", "_WINDOWED_FEATURES")})
    proven.update({name: "ml-service/app/universal_training.py:724-727 hashes the contract only when "
                         "req.pit_contract_version is not None (probe prep_pit_contract_none). " + r33_only
                   for name in ("APPROVAL_KEYS", "canonical_sha256", "content_sha256")})
    uncovered = [row for row in reachable_changes if row["symbol"] not in covered | set(proven)]
    report = {"schema_version": "r33-serving-parity-v1", "base": args.base, "static": static,
              "dynamic": dynamic, "proven_by_code": proven, "uncovered_reachable_changes": uncovered,
              "status": "pass" if dynamic["status"] == "pass" and not uncovered else "fail"}
    text = json.dumps(report, indent=2, sort_keys=True, default=str)
    if args.json:
        Path(args.json).write_text(text, encoding="utf-8")
    print(text)
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
