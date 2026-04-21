"""
modal_app_quantaalpha.py — #11 QuantaAlpha POC (Phase 1 T1.1)

Runs on Modal (python 3.10) — base image clones QuantaAlpha repo, installs Qlib,
configures Gemini 3.1 Flash Lite via OpenAI-compatible endpoint. Consumes a
pre-built Qlib binary directory (built by scripts/d1_to_qlib_adapter.py, T1.2)
mounted via a Modal Volume at /data/qlib_tw.

Entry points:
  @app.function run_mine_cycle(research_direction, experiment_suffix)
    → ./run.sh "<research direction>" inside container
    → returns factor library JSON + log tail

  @app.function run_backtest(config_path)
    → python -m quantaalpha.backtest.run_backtest -c <config>

Deploy:
  cd ml-service && python3 -m modal deploy modal_app_quantaalpha.py

Local dev (POC):
  python3 -m modal serve modal_app_quantaalpha.py

2026-04-21 Phase 1 — not production yet, POC gate guards production cron wiring.
"""

from __future__ import annotations

import os
import subprocess
import modal
from pathlib import Path

APP_NAME = "quantaalpha-poc"

# ── Image: python 3.10 required by QuantaAlpha repo ─────────────────────────
# git clone target: /opt/quantaalpha (editable install in-container)
# Qlib installed separately (QuantaAlpha's requirements may or may not pin).
image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("git", "build-essential", "libgomp1", "wget", "unzip")
    .pip_install(
        "pyqlib==0.9.6",            # Qlib pinned (0.9.5 not on PyPI as of 2026-04; 0.9.6/0.9.7 available)
        "numpy<2.0",                # Qlib dump_bin compatibility
        "pandas>=2.0",
        "tables>=3.8",              # HDF5 support (daily_pv.h5)
        "pyyaml",
        "tqdm",
        "openai>=1.0",              # OpenAI-compatible SDK for Gemini endpoint
        "scikit-learn",
        "loguru",
        "requests",                 # D1 REST client in build_qlib_binary
    )
    .run_commands(
        "git clone --depth 1 https://github.com/QuantaAlpha/QuantaAlpha.git /opt/quantaalpha",
        "cd /opt/quantaalpha && SETUPTOOLS_SCM_PRETEND_VERSION=0.1.0 pip install -e . || true",
        # requirements.txt may pull extras; allow failures to surface at runtime not build
        "cd /opt/quantaalpha && pip install -r requirements.txt || echo 'requirements partial — surface at runtime'",
        # Qlib PyPI 不包含 dump_bin.py，需從 source clone 取 scripts/
        "git clone --depth 1 https://github.com/microsoft/qlib /opt/qlib-src",
    )
)

app = modal.App(APP_NAME, image=image)

# ── Volume: persists Qlib binary + output artifacts across runs ─────────────
# Filled by scripts/d1_to_qlib_adapter.py (T1.2, local or separate function).
qlib_volume = modal.Volume.from_name("quantaalpha-qlib-tw", create_if_missing=True)
results_volume = modal.Volume.from_name("quantaalpha-results", create_if_missing=True)

# ── Secrets ────────────────────────────────────────────────────────────────
# quantaalpha-llm: GEMINI_API_KEY (created by /admin/quantaalpha-bootstrap)
# stockvision-cf: CF_API_TOKEN / CF_ACCOUNT_ID / CF_D1_DB_ID (already exists
#   from ml-service/modal_app.py, reused for D1 REST access in build_qlib_binary)
def _opt_secret(name: str) -> modal.Secret:
    try:
        return modal.Secret.from_name(name)
    except Exception:
        return modal.Secret.from_dict({})

llm_secret = _opt_secret("quantaalpha-llm")
# Use quantaalpha-cf (not stockvision-cf) to avoid coupling with ml-service
# Created by /admin/quantaalpha-bootstrap from ml-controller Cloud Run env vars.
cf_secret = _opt_secret("quantaalpha-cf")

VOL_QLIB = "/data/qlib_tw"
VOL_RESULTS = "/data/results"


def _gemini_env() -> dict[str, str]:
    """OpenAI-compatible endpoint config for Gemini 3.1 Flash Lite."""
    api_key = os.environ.get("GEMINI_API_KEY", "")
    return {
        "OPENAI_API_KEY": api_key,
        "OPENAI_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
        "CHAT_MODEL": "gemini-3.1-flash-lite",
        "REASONING_MODEL": "gemini-3.1-flash-lite",
        "QLIB_DATA_DIR": VOL_QLIB,
        "DATA_RESULTS_DIR": VOL_RESULTS,
    }


@app.function(
    secrets=[llm_secret],
    volumes={VOL_QLIB: qlib_volume, VOL_RESULTS: results_volume},
    timeout=60 * 60 * 6,  # 6 hr cap per POC budget (T1.5 success criterion)
    cpu=4.0,
    memory=16384,
)
def run_mine_cycle(research_direction: str, experiment_suffix: str = "poc") -> dict:
    """One QuantaAlpha mining cycle.

    Returns dict with:
      - status: "ok" | "error"
      - direction: <research_direction>
      - factor_library_path: path within results volume
      - stdout_tail: last 2000 chars of stdout
      - stderr_tail: last 2000 chars of stderr
      - duration_sec: float
    """
    import time
    t0 = time.time()

    env = os.environ.copy()
    gemini_env = _gemini_env()
    env.update(gemini_env)

    # run.sh 要 /opt/quantaalpha/.env 存在 → 寫一份從 gemini_env 值
    env_file = Path("/opt/quantaalpha/.env")
    try:
        env_file.write_text(
            "\n".join(f"{k}={v}" for k, v in gemini_env.items()) + "\n",
            encoding="utf-8",
        )
    except Exception as e:
        return {"status": "error", "reason": f"failed to write .env: {e}"}

    # run.sh lives at /opt/quantaalpha/run.sh
    cmd = ["bash", "/opt/quantaalpha/run.sh", research_direction, experiment_suffix]
    try:
        proc = subprocess.run(
            cmd,
            cwd="/opt/quantaalpha",
            env=env,
            capture_output=True,
            text=True,
            timeout=60 * 60 * 5,  # 5 hr internal timeout; outer = 6 hr
        )
        status = "ok" if proc.returncode == 0 else "error"
        stdout_tail = proc.stdout[-2000:] if proc.stdout else ""
        stderr_tail = proc.stderr[-2000:] if proc.stderr else ""
    except subprocess.TimeoutExpired as e:
        status = "timeout"
        stdout_tail = (e.stdout or "")[-2000:] if e.stdout else ""
        stderr_tail = (e.stderr or "")[-2000:] if e.stderr else ""

    # Find the latest all_factors_library*.json
    results_dir = Path(VOL_RESULTS)
    factor_files = sorted(results_dir.rglob("all_factors_library*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    factor_library_path = str(factor_files[0]) if factor_files else ""

    results_volume.commit()
    result = {
        "status": status,
        "direction": research_direction,
        "experiment_suffix": experiment_suffix,
        "factor_library_path": factor_library_path,
        "stdout_tail": stdout_tail[-800:] if stdout_tail else "",
        "stderr_tail": stderr_tail[-800:] if stderr_tail else "",
        "duration_sec": round(time.time() - t0, 1),
    }
    import json as _json
    print(f"[RESULT] {_json.dumps(result)}")
    return result


@app.function(
    secrets=[cf_secret],
    volumes={VOL_QLIB: qlib_volume},
    timeout=60 * 60 * 2,   # 2 hr cap — 350 symbols × 5 yr via CF REST
    cpu=2.0,
    memory=8192,
)
def build_qlib_binary(universe_name: str = "sv_screener_350", years: int = 5) -> dict:
    """D1 stock_prices → Qlib binary format (all in-container via Modal)."""
    import csv
    import subprocess
    import sys
    import time
    import requests

    t0 = time.time()
    account = os.environ.get("CF_ACCOUNT_ID", "")
    db = os.environ.get("CF_D1_DB_ID", "")
    token = os.environ.get("CF_API_TOKEN", "")
    if not all([account, db, token]):
        return {"status": "error", "reason": "CF env vars missing (need CF_ACCOUNT_ID/CF_D1_DB_ID/CF_API_TOKEN)"}

    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"

    def d1_query(sql: str, params=None):
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"sql": sql, "params": params or []},
            timeout=120,
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("success"):
            raise RuntimeError(f"D1 query failed: {data}")
        return data["result"][0].get("results", [])

    # Universe = 近 30 天曾進 screener candidate 的股票（350 檔浮動池）+ 現 watchlist
    # in_current_watchlist=1 只有 ~32，太小 → 改 union screener history 近 30 天
    universe_rows = d1_query(
        """SELECT DISTINCT symbol FROM (
             SELECT symbol FROM daily_recommendations WHERE date >= date('now', '-30 days')
             UNION
             SELECT symbol FROM stocks WHERE in_current_watchlist=1
           )
           WHERE symbol IS NOT NULL
           ORDER BY symbol"""
    )
    universe = [r["symbol"] for r in universe_rows]
    print(f"[build_qlib_binary] universe size: {len(universe)}")

    out_dir = Path(VOL_QLIB)
    csv_dir = out_dir / "_csv"
    csv_dir.mkdir(parents=True, exist_ok=True)

    start_date = time.strftime("%Y-%m-%d", time.localtime(t0 - years * 365 * 86400))
    symbol_dates: dict[str, tuple[str, str]] = {}
    written = 0
    for i, sym in enumerate(universe):
        try:
            rows = d1_query(
                """SELECT sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume, sp.adj_close
                   FROM stock_prices sp
                   JOIN stocks s ON sp.stock_id = s.id
                   WHERE s.symbol = ? AND sp.date >= ?
                     AND sp.close IS NOT NULL AND sp.volume IS NOT NULL
                   ORDER BY sp.date""",
                params=[sym, start_date],
            )
        except Exception as e:
            print(f"[{i+1}/{len(universe)}] {sym} fetch failed: {e}")
            continue
        if len(rows) < 30:
            continue
        csv_path = csv_dir / f"{sym}.csv"
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["date", "open", "close", "high", "low", "volume", "factor", "vwap", "symbol"])
            for row in rows:
                close = row["close"]
                adj = row.get("adj_close") or close
                factor = (adj / close) if (close and close > 0) else 1.0
                vwap = (row["high"] + row["low"] + close) / 3.0 if (row.get("high") and row.get("low")) else close
                w.writerow([
                    row["date"],
                    row.get("open") or close,
                    close,
                    row.get("high") or close,
                    row.get("low") or close,
                    row.get("volume") or 0,
                    round(factor, 6),
                    round(vwap, 4),
                    sym,
                ])
        symbol_dates[sym] = (rows[0]["date"], rows[-1]["date"])
        written += 1
        if (i + 1) % 25 == 0:
            print(f"[{i+1}/{len(universe)}] cumulative {written} CSVs, elapsed {int(time.time()-t0)}s")

    # Instruments file
    instruments_dir = out_dir / "instruments"
    instruments_dir.mkdir(parents=True, exist_ok=True)
    for fname in (f"{universe_name}.txt", "all.txt"):
        with (instruments_dir / fname).open("w", encoding="utf-8") as f:
            for sym, (start, end) in sorted(symbol_dates.items()):
                f.write(f"{sym}\t{start}\t{end}\n")

    # Qlib dump_bin — use /opt/qlib-src/scripts/dump_bin.py cloned at image build
    dump_err = None
    dump_stdout_tail = ""
    dump_stderr_tail = ""
    dump_bin_candidates = [
        Path("/opt/qlib-src/scripts/dump_bin.py"),
    ]
    try:
        import qlib
        qlib_root = Path(qlib.__file__).parent
        dump_bin_candidates.extend([
            qlib_root / "tests" / "data" / "dump_bin.py",
            qlib_root.parent / "scripts" / "dump_bin.py",
        ])
    except ImportError:
        pass
    dump_bin = next((p for p in dump_bin_candidates if p.is_file()), None)
    if not dump_bin:
        dump_err = f"dump_bin.py not found in candidates: {[str(p) for p in dump_bin_candidates]}"
    else:
        try:
            # Qlib dump_bin CLI: arg is `data_path` not `csv_path` (confirmed via source)
            p = subprocess.run([
                sys.executable, str(dump_bin), "dump_all",
                "--data_path", str(csv_dir),
                "--qlib_dir", str(out_dir),
                "--freq", "day",
                "--max_workers", "4",
                "--include_fields", "open,close,high,low,volume,factor,vwap",
            ], capture_output=True, text=True, timeout=60 * 30)
            dump_stdout_tail = (p.stdout or "")[-500:]
            dump_stderr_tail = (p.stderr or "")[-500:]
            if p.returncode != 0:
                dump_err = f"dump_bin rc={p.returncode}"
        except Exception as e:
            dump_err = str(e)

    qlib_volume.commit()

    n_symbols = len(list((out_dir / "features").iterdir())) if (out_dir / "features").is_dir() else 0
    result = {
        "status": "ok" if not dump_err else "partial",
        "universe_size": len(universe),
        "csvs_written": written,
        "symbols_in_features_dir": n_symbols,
        "qlib_dir": str(out_dir),
        "dump_bin_used": str(dump_bin) if dump_bin else None,
        "dump_error": dump_err,
        "dump_stdout_tail": dump_stdout_tail,
        "dump_stderr_tail": dump_stderr_tail,
        "duration_sec": round(time.time() - t0, 1),
    }
    import json as _json
    print(f"[RESULT] {_json.dumps(result)}")
    return result


@app.function(
    volumes={VOL_QLIB: qlib_volume, VOL_RESULTS: results_volume},
    timeout=60 * 30,
)
def check_qlib_data() -> dict:
    """Sanity check: is the Qlib binary directory populated?"""
    qlib = Path(VOL_QLIB)
    has_instruments = (qlib / "instruments").is_dir()
    has_features = (qlib / "features").is_dir()
    n_instruments_files = len(list((qlib / "instruments").glob("*.txt"))) if has_instruments else 0
    n_symbols = len(list((qlib / "features").iterdir())) if has_features else 0
    result = {
        "qlib_dir": str(qlib),
        "exists": qlib.exists(),
        "has_instruments": has_instruments,
        "has_features": has_features,
        "instruments_files": n_instruments_files,
        "symbols_count": n_symbols,
    }
    import json as _json
    print(f"[RESULT] {_json.dumps(result)}")
    return result


@app.local_entrypoint()
def main(direction: str = "Price-Volume Factor Mining", suffix: str = "poc"):
    """Local entry: `modal run modal_app_quantaalpha.py --direction '...'`."""
    print(f"[local] Checking Qlib data volume...")
    print(check_qlib_data.remote())
    print(f"[local] Starting mine cycle: {direction}")
    result = run_mine_cycle.remote(direction, suffix)
    print("=== Mine cycle result ===")
    for k, v in result.items():
        if k in ("stdout_tail", "stderr_tail"):
            print(f"{k}:\n{v}\n")
        else:
            print(f"{k}: {v}")
