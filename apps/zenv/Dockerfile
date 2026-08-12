# sjasmplus toolchain, built from the pinned release tarball — the same
# version the sjasmplus and pasta80 services pin. Unlike the standalone
# sjasmplus service this build does NOT enable Lua: the asm fed to sjasmplus
# here is the vendored zenv tree plus a generated user.asm whose user content
# is data bytes only, so nothing needs (or should have) a scripting engine.
FROM alpine:3.22 AS toolchain
RUN apk add --no-cache build-base curl xz
ARG SJASMPLUS_VERSION=1.23.1
ARG SJASMPLUS_SHA256=0203a01199b16660027fbe04b0a87dc5aff299401b5e3e49bff8468a3801cc54
RUN curl -fsSL -o /tmp/sjasmplus-src.tar.xz \
        "https://github.com/z00m128/sjasmplus/releases/download/v${SJASMPLUS_VERSION}/sjasmplus-${SJASMPLUS_VERSION}-src.tar.xz" \
    && echo "${SJASMPLUS_SHA256}  /tmp/sjasmplus-src.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/sjasmplus-src.tar.xz -C /tmp \
    && make -C "/tmp/sjasmplus-${SJASMPLUS_VERSION}" -j"$(nproc)" \
    && install -m 0755 "/tmp/sjasmplus-${SJASMPLUS_VERSION}/sjasmplus" /usr/local/bin/sjasmplus

# zenv (Forth for the ZX Spectrum), vendored at a pinned commit with the
# boot patch applied: `main` runs the generated user_boot word before the
# interpreter loop, and the image includes user.asm before h_init (see
# zenv-boot.patch and app/routes/compile.py). MIT licence, (C) Christopher
# Leonard — https://github.com/Veltas/zenv
FROM alpine:3.22 AS zenv
RUN apk add --no-cache curl patch
ARG ZENV_COMMIT=3ebcfd8c84f5720b412a7fdcdbf2173aefda618b
ARG ZENV_SHA256=bf0805f740eb89aa725388ca7bfb7625dcb3c60bfa0d10ba3d09dd58756b1025
RUN curl -fsSL -o /tmp/zenv-src.tar.gz \
        "https://github.com/Veltas/zenv/archive/${ZENV_COMMIT}.tar.gz" \
    && echo "${ZENV_SHA256}  /tmp/zenv-src.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/zenv \
    && tar -xzf /tmp/zenv-src.tar.gz -C /opt/zenv --strip-components=1
COPY zenv-boot.patch /tmp/zenv-boot.patch
RUN patch -d /opt/zenv -p1 < /tmp/zenv-boot.patch

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
COPY --from=zenv /opt/zenv/src /opt/zenv/src
COPY --from=zenv /opt/zenv/COPYING.txt /opt/zenv/COPYING.txt
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
# endpoint is sync, so each in-flight request holds a threadpool slot and
# may spawn the assembler). No compile serialization is needed here: user
# content is embedded as data bytes only, so Lua/directives are unreachable
# (see app/routes/compile.py).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--limit-concurrency", "12"]
