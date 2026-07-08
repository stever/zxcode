# z88dk toolchain (pinned). The upstream image is Alpine/musl, so everything
# downstream must stay musl too: copying /opt/z88dk into a glibc (Debian) base
# leaves zcc unable to load (missing /lib/ld-musl-x86_64.so.1).
FROM z88dk/z88dk:2.4 AS z88dk

# Build Python deps into an isolated venv so the runtime image carries no
# host compiler (build-base stays in this stage only).
FROM python:3.12-alpine3.22 AS builder
RUN apk add --no-cache build-base
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Runtime: minimal musl base matching the z88dk toolchain build, plus the
# shared libs the z88dk binaries link against (zsdcc needs libstdc++/libgcc,
# z88dk-asmpp needs gmp, others need libxml2/xz).
FROM python:3.12-alpine3.22

RUN apk add --no-cache libstdc++ libgcc gmp libxml2 xz-libs m4

COPY --from=z88dk /opt/z88dk /opt/z88dk
COPY --from=builder /opt/venv /opt/venv

ENV Z88DK_PATH="/opt/z88dk" \
    PATH="/opt/venv/bin:/opt/z88dk/bin:${PATH}" \
    ZCCCFG="/opt/z88dk/lib/config/" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Non-root, no login shell.
RUN addgroup -g 1001 -S appuser \
    && adduser -u 1001 -S -G appuser -h /home/appuser -s /sbin/nologin appuser

WORKDIR /app
COPY --chown=appuser:appuser . /app/
USER appuser

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:80/health', timeout=3).status==200 else 1)"

# zcc runs with its temp dir as CWD and writes only under /tmp (a writable
# tmpfs), so /app stays read-only. --limit-concurrency sheds a request flood
# as 503 rather than exhausting threads/memory (the compile endpoint is sync,
# so each in-flight request holds a threadpool slot and may spawn the compiler
# chain).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--limit-concurrency", "12"]
