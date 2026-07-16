# Root Dockerfile for ml-controller Cloud Run Service + pipeline-v2 Cloud Run Job
# Build context = repo root so we can include BOTH ml-controller/ and ml-service/.
#
# Why at repo root (2026-04-21 T1.0 Option A):
#   Previously ml-controller/Dockerfile used `COPY . .` with build context =
#   ml-controller/. That meant ml-service/ source was NOT in the image, so the
#   modal-deploy flow required Wei to run `modal deploy ml-service/modal_app.py`
#   from a local workstation (needed ml-service source file on disk).
#
#   By moving the Dockerfile to repo root and expanding the COPY to include
#   ml-service/, modal_app.py ships inside the ml-controller container, and a
#   new /admin/modal-deploy endpoint (routers/admin.py) can subprocess-call
#   `modal deploy /app/ml-service/modal_app.py` using the already-mounted
#   MODAL_TOKEN_ID/SECRET env vars.
#
# Image still Python 3.11 slim with only ml-controller/requirements.txt (FastAPI
# + modal client). ml-service itself never runs in this image - it lives on
# Modal's cloud; we only need its source so modal CLI can parse + upload it.
#
# Size impact: ~few MB (ml-service/app/*.py source only, no ml-service deps).

FROM python:3.11-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS python-dependencies

WORKDIR /app

RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip==26.1.2 setuptools==83.0.0

COPY ml-controller/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

# Worker screener job runtime. The Cloud Run Job compiles and runs the same
# TypeScript screener code with D1/KV REST adapters instead of Worker bindings.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS worker-build

WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci
COPY worker/ ./
RUN ./node_modules/.bin/tsc -p tsconfig.json --noEmit false --rootDir src --outDir /app/worker-dist --module commonjs --moduleResolution node --ignoreDeprecations 6.0

FROM python:3.11-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8080

WORKDIR /app

COPY --from=python-dependencies /opt/venv /opt/venv
COPY --from=worker-build /usr/local/bin/node /usr/local/bin/node
COPY --from=worker-build /app/worker-dist /app/worker-dist

RUN node --version \
    && python -c "import fastapi, modal, uvicorn"

RUN mkdir -p /app/data
COPY data/finlab_source_contract.json /app/data/finlab_source_contract.json

# Application source.
COPY ml-controller/ /app/
COPY ml-service/ /app/ml-service/
RUN mkdir -p /app/data/finlab_research
COPY data/finlab_research/dagster_asset_graph.json /app/data/finlab_research/dagster_asset_graph.json
RUN mkdir -p /app/data/feature_registry /app/output/feature_universe_triage /app/worker
COPY data/feature_registry/*.json /app/data/feature_registry/
COPY output/feature_universe_triage/feature_registry_local_closure_20260617.json /app/output/feature_universe_triage/feature_registry_local_closure_20260617.json
COPY output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv /app/output/feature_universe_triage/formal137_pairwise_similarity_long_20260617.csv
COPY worker/migration_strategy_mining_ledger_2026_06_18.sql /app/worker/migration_strategy_mining_ledger_2026_06_18.sql
RUN mkdir -p /app/tools
COPY tools/finlab_v4_remote_backfill.py /app/tools/finlab_v4_remote_backfill.py
COPY tools/finlab_macro_context_snapshot.py /app/tools/finlab_macro_context_snapshot.py
COPY tools/materialize_external_evidence_once.py /app/tools/materialize_external_evidence_once.py
COPY tools/external_evidence_v4_local_packet.py /app/tools/external_evidence_v4_local_packet.py
COPY tools/finlab_alpha_miner_bakeoff.py /app/tools/finlab_alpha_miner_bakeoff.py
COPY tools/finlab_alphabuilders_factor_backtest.py /app/tools/finlab_alphabuilders_factor_backtest.py
COPY tools/finlab_strategy_spec_backtest.py /app/tools/finlab_strategy_spec_backtest.py
COPY tools/feature_strategy_overlap_numeric.py /app/tools/feature_strategy_overlap_numeric.py

# Runtime containers never need root. Keep application-owned output paths
# writable for Cloud Run Jobs while preserving read-only source semantics.
RUN useradd --create-home --uid 10001 stockvision \
    && chown -R stockvision:stockvision /app
USER stockvision

EXPOSE 8080

# uvicorn single worker (Cloud Run scales horizontally).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
