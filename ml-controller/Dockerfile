# ml-controller/Dockerfile — Cloud Run ML Controller
# Python 3.11 slim，極輕量（無 ML 套件，只有 FastAPI + Modal client）
FROM python:3.11-slim

WORKDIR /app

# 依賴層（先 COPY 利用 Docker layer cache）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製程式碼
COPY . .

# Cloud Run 預設 PORT=8080
ENV PORT=8080
EXPOSE 8080

# uvicorn：單 worker 足夠（Cloud Run 水平擴展；Modal .map() 已自動並行）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
