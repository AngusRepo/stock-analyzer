FROM python:3.11-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS dependencies

WORKDIR /app

RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip==26.1.2 setuptools==83.0.0

# Compilers stay in the dependency stage; the runtime only receives the venv.
RUN apt-get update && apt-get install -y \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-neuralforecast.txt ./
# Prefer binary wheels to keep Cloud Run source builds deterministic.
RUN /opt/venv/bin/pip install --no-cache-dir --prefer-binary -r requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir --prefer-binary --no-deps -r requirements-neuralforecast.txt \
    && /opt/venv/bin/python -c "import neuralforecast, pytorch_lightning; from neuralforecast.models import DLinear, PatchTST, iTransformer; assert pytorch_lightning.__version__ == '2.6.1'"

FROM python:3.11-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8080

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies /opt/venv /opt/venv

COPY app/ ./app/

RUN useradd --create-home --uid 10001 stockvision \
    && chown -R stockvision:stockvision /app \
    && python -c "import lightgbm, neuralforecast, torch, xgboost; from neuralforecast.models import DLinear, PatchTST, iTransformer"
USER stockvision

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
