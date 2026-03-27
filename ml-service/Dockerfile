FROM python:3.10-slim

WORKDIR /app

# 安裝系統依賴（Prophet / LightGBM 需要）
RUN apt-get update && apt-get install -y \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# 升級 pip 確保能找到 manylinux wheel；river 需要 --prefer-binary 避免觸發 Rust 原始碼編譯
RUN pip install --upgrade pip && \
    pip install --no-cache-dir --prefer-binary -r requirements.txt

COPY app/ ./app/

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
