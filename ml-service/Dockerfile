FROM python:3.11-slim

WORKDIR /app

RUN python -m pip install --no-cache-dir --upgrade pip==26.1.2 setuptools==83.0.0

# Runtime libraries for LightGBM / tree-model inference paths.
RUN apt-get update && apt-get install -y \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-neuralforecast.txt ./
# Prefer binary wheels to keep Cloud Run source builds deterministic.
RUN pip install --no-cache-dir --prefer-binary -r requirements.txt \
    && pip install --no-cache-dir --prefer-binary --no-deps -r requirements-neuralforecast.txt \
    && python -c "import neuralforecast, pytorch_lightning; from neuralforecast.models import DLinear, PatchTST, iTransformer; assert pytorch_lightning.__version__ == '2.6.1'"

COPY app/ ./app/

RUN useradd --create-home --uid 10001 stockvision \
    && chown -R stockvision:stockvision /app
USER stockvision

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
