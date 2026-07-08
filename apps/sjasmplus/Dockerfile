# sjasmplus toolchain, built from the pinned release tarball. USE_LUA is the
# ONLY gate on the embedded Lua scripting engine — there is no runtime flag.
# Building with USE_LUA=1 means every compile can execute arbitrary code (LUA
# directives get the full Lua stdlib: os.execute, io, sockets), so the
# container must be treated as hostile. That is acceptable only with the full
# set of mitigations in place: read-only root + capped tmpfs, dropped
# capabilities, no-new-privileges, non-root, per-compile RLIMITs, the
# per-compiler internal network in the deploy repo (zxcode-docker-compose),
# and the compile serialization in app/routes/compile.py that stops one
# compile reading another's in-flight source. Lua IS enabled; keep all of
# those in place while it stays on.
FROM alpine:3.22 AS toolchain
RUN apk add --no-cache build-base curl xz
ARG SJASMPLUS_VERSION=1.23.1
ARG SJASMPLUS_SHA256=0203a01199b16660027fbe04b0a87dc5aff299401b5e3e49bff8468a3801cc54
RUN curl -fsSL -o /tmp/sjasmplus-src.tar.xz \
        "https://github.com/z00m128/sjasmplus/releases/download/v${SJASMPLUS_VERSION}/sjasmplus-${SJASMPLUS_VERSION}-src.tar.xz" \
    && echo "${SJASMPLUS_SHA256}  /tmp/sjasmplus-src.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/sjasmplus-src.tar.xz -C /tmp \
    && make -C "/tmp/sjasmplus-${SJASMPLUS_VERSION}" USE_LUA=1 -j"$(nproc)" \
    && install -m 0755 "/tmp/sjasmplus-${SJASMPLUS_VERSION}/sjasmplus" /usr/local/bin/sjasmplus

# Build Python deps into an isolated venv so the runtime image carries no
# host compiler (build-base stays in this stage only).
FROM python:3.12-alpine3.22 AS builder
RUN apk add --no-cache build-base
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Runtime: minimal musl base matching the toolchain build; the sjasmplus
# binary only needs libstdc++/libgcc beyond the base.
FROM python:3.12-alpine3.22

RUN apk add --no-cache libstdc++

COPY --from=toolchain /usr/local/bin/sjasmplus /usr/local/bin/sjasmplus
COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
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

# sjasmplus runs with its temp dir as CWD and writes only under /tmp (a
# writable tmpfs), so /app stays read-only. --limit-concurrency sheds a
# request flood as 503 rather than exhausting threads/memory (the compile
# endpoint is sync, so each in-flight request holds a threadpool slot and may
# spawn the assembler). It counts ALL connections including /health, so do
# not lower it to 1 to serialize compiles — that would 503 the healthcheck
# during every compile. Compiles are serialized by the lock in
# app/routes/compile.py instead.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--limit-concurrency", "12"]
