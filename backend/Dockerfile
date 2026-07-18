# Backend container, deployed on Northflank (Docker).
# Northflank injects $PORT and routes external traffic to it; we bind that port below.
#
# Multi-stage: the `tests` stage runs the suite during the build, so a failing test
# aborts the build and nothing is deployed. Test dependencies stay out of the final
# image. Skip the gate with --build-arg SKIP_TESTS=1 (use sparingly).

FROM python:3.11-slim AS base

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt


FROM base AS tests

ARG SKIP_TESTS=0
# Reads requirements-dev.txt so the test-tooling pins live in exactly one place.
# Runtime deps are already satisfied from `base`, so pip only adds the extras.
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
# Tests are hermetic (Supabase is faked), so no credentials are needed here.
RUN if [ "$SKIP_TESTS" = "1" ]; then \
        echo "SKIP_TESTS=1 — skipping test gate"; \
    else \
        python -m pytest -q; \
    fi


FROM base AS runtime

# Copying from `tests` makes that stage a build dependency, so BuildKit cannot skip
# it — a failing suite fails the build before this image is produced.
COPY --from=tests /app/pytest.ini /app/pytest.ini
COPY . .

EXPOSE 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
