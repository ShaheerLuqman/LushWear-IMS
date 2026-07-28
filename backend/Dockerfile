# Backend container, deployed on Northflank (Docker).
# Northflank injects $PORT and routes external traffic to it; we bind that port below.
#
# Multi-stage: the `tests` stage can run the suite during the build (test deps stay
# out of the final image either way). Tests are skipped by default here — GitHub
# Actions (.github/workflows/backend-tests.yml) is the test gate; pass
# --build-arg SKIP_TESTS=0 to also run the suite as part of this build.

FROM python:3.11-slim AS base

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt


FROM base AS tests

ARG SKIP_TESTS=1
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
# it. With SKIP_TESTS=0 that means a failing suite fails the build before this
# image is produced; with the default SKIP_TESTS=1 it's just plumbing for
# pytest.ini and doesn't gate anything.
COPY --from=tests /app/pytest.ini /app/pytest.ini
COPY . .

# Runs as an unprivileged user - nothing here writes to disk (PDFs are generated
# in-memory), so a read-only, non-root /app is a pure hardening step, not a risk.
RUN addgroup --system app && adduser --system --ingroup app app \
    && chown -R app:app /app
USER app

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://localhost:' + os.environ.get('PORT', '7860') + '/health', timeout=3)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
