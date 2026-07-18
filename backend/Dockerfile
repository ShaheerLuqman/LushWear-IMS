# Backend container, deployed on Northflank (Docker).
# Northflank injects $PORT and routes external traffic to it; we bind that port below.
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Bind the port the platform provides ($PORT), falling back to 7860 for local runs.
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
