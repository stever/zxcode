# Build Python deps into an isolated venv so the runtime image carries no
# compiler toolchain (gcc stays in this stage only).
FROM python:3.12-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Runtime: minimal official slim base, no build tools.
# Python 3.12 is required by the bundled ZX Basic compiler (1.18.7 needs >=3.11)
# and runs the current FastAPI / Pydantic v2 stack. Keep both stages on the same
# version.
FROM python:3.12-slim-bookworm

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Non-root, no login shell.
RUN groupadd -g 1000 zxbasic \
    && useradd -r -u 1000 -g zxbasic -m -d /home/zxbasic -s /usr/sbin/nologin zxbasic

WORKDIR /app
COPY --chown=zxbasic:zxbasic . /app/
USER zxbasic

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:80/health', timeout=3).status==200 else 1)"

# zxbc writes the .tap into a temp dir under /tmp (a writable tmpfs), so /app
# stays read-only. --limit-concurrency sheds a request flood as 503 rather
# than exhausting threads/memory (the compile endpoint is sync, so each
# in-flight request holds a threadpool slot and may spawn the compiler).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--limit-concurrency", "12"]
