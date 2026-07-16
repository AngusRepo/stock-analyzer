ARG WOLFI_BASE=cgr.dev/chainguard/wolfi-base@sha256:02dab76bd852a70556b5b2002195c8a5fdab77d323c433bf6642aab080489795

FROM ${WOLFI_BASE} AS dependencies

WORKDIR /app

RUN apk add --no-cache \
        python-3.11=3.11.15-r8 \
        python-3.11-dev=3.11.15-r8 \
        py3.11-pip=26.1.2-r1 \
        build-base=1-r9 \
    && python3.11 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip==26.1.2 setuptools==83.0.0

COPY requirements.txt requirements-neuralforecast.txt ./
# Prefer binary wheels to keep Cloud Run source builds deterministic.
RUN /opt/venv/bin/pip install --no-cache-dir --prefer-binary -r requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir --prefer-binary --no-deps -r requirements-neuralforecast.txt \
    && /opt/venv/bin/python -c "import neuralforecast, pytorch_lightning; from neuralforecast.models import DLinear, PatchTST, iTransformer; assert pytorch_lightning.__version__ == '2.6.1'"

FROM ${WOLFI_BASE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8080

WORKDIR /app

RUN apk add --no-cache \
        python-3.11=3.11.15-r8 \
        libstdc++=16.1.0-r4 \
        libgomp=16.1.0-r4

COPY --from=dependencies /opt/venv /opt/venv

COPY app/ ./app/

RUN addgroup -S -g 10001 stockvision \
    && adduser -S -D -H -u 10001 -G stockvision stockvision \
    && chown -R 10001:10001 /app \
    && python -c "import lightgbm, neuralforecast, torch, xgboost; from neuralforecast.models import DLinear, PatchTST, iTransformer"
USER stockvision

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
