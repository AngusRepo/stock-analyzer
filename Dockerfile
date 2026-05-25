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

FROM python:3.11-slim

WORKDIR /app

# System deps for subprocess modal CLI + git (audit, future needs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python deps (ml-controller only; ml-service deps live on Modal cloud).
COPY ml-controller/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application source.
COPY ml-controller/ /app/
COPY ml-service/ /app/ml-service/
RUN mkdir -p /app/data/finlab_research
COPY data/finlab_research/dagster_asset_graph.json /app/data/finlab_research/dagster_asset_graph.json
COPY tools/ /app/tools/

ENV PORT=8080
EXPOSE 8080

# uvicorn single worker (Cloud Run scales horizontally).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
