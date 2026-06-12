FROM python:3.12-slim

WORKDIR /app

# Runtime libraries for LightGBM / tree-model inference paths.
RUN apt-get update && apt-get install -y \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Prefer binary wheels to keep Cloud Run source builds deterministic.
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --prefer-binary -r requirements.txt

COPY app/ ./app/

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
