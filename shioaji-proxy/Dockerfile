FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Cloud Run 用 PORT 環境變數
ENV PORT=8080
EXPOSE 8080

CMD ["python", "main.py"]
