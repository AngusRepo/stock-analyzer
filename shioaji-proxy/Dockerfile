FROM python:3.11-slim

WORKDIR /app

RUN python -m pip install --no-cache-dir --upgrade pip==26.1.2 setuptools==83.0.0

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN useradd --create-home --uid 10001 stockvision \
    && chown -R stockvision:stockvision /app
USER stockvision

# Cloud Run 用 PORT 環境變數
ENV PORT=8080
EXPOSE 8080

CMD ["python", "main.py"]
