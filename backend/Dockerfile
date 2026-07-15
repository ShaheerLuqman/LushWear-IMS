# Backend container for Hugging Face Spaces (Docker SDK).
# HF routes external traffic to the port declared as `app_port` in README.md (7860).
FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Bind the port the platform provides ($PORT), falling back to 7860 (HF Spaces default).
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
