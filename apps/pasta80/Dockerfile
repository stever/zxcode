# sjasmplus toolchain, built from the pinned release tarball. Unlike the
# standalone sjasmplus service this build keeps Lua enabled: Pasta80's code
# generator registers rtl/helpers.lua with the assembler and its output does
# not assemble without it. The asm fed to sjasmplus here is compiler-generated
# (users write Pascal, not asm), and the container is hardened the same way
# regardless (read-only root, caps dropped, RLIMITs, no secrets).
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

# Pasta80 compiler, built with Free Pascal from the pinned release tag. Built
# on Debian because Alpine carries no fpc package; the resulting binary is
# fully static (FPC links its own RTL, no libc), so it runs on the musl
# runtime image unchanged. The compiler needs its rtl/ (Pascal+asm runtime)
# and misc/ (BASIC tape loaders) directories at run time.
FROM debian:bookworm-slim AS pasta
RUN apt-get update && apt-get install -y --no-install-recommends fpc ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG PASTA80_VERSION=0.99
ARG PASTA80_SHA256=6075ac7327447ffc8821dacb3838008e1ac24ddc4ccdf3f4e1eadb7ccda85eca
RUN curl -fsSL -o /tmp/pasta80-src.tar.gz \
        "https://github.com/pleumann/pasta80/archive/refs/tags/v${PASTA80_VERSION}.tar.gz" \
    && echo "${PASTA80_SHA256}  /tmp/pasta80-src.tar.gz" | sha256sum -c - \
    && mkdir /opt/pasta80 \
    && tar -xzf /tmp/pasta80-src.tar.gz -C /opt/pasta80 --strip-components=1 \
    && cd /opt/pasta80 \
    && fpc -O2 pasta.pas

# Build Python deps into an isolated venv so the runtime image carries no
# host compiler (build-base stays in this stage only).
FROM python:3.12-alpine3.22 AS builder
RUN apk add --no-cache build-base
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Runtime: minimal musl base matching the sjasmplus build; the sjasmplus
# binary only needs libstdc++/libgcc beyond the base, and the pasta binary is
# static.
FROM python:3.12-alpine3.22

RUN apk add --no-cache libstdc++

COPY --from=toolchain /usr/local/bin/sjasmplus /usr/local/bin/sjasmplus
COPY --from=pasta /opt/pasta80/pasta /usr/local/bin/pasta
COPY --from=pasta /opt/pasta80/rtl /opt/pasta80/rtl
COPY --from=pasta /opt/pasta80/misc /opt/pasta80/misc
COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Non-root, no login shell. pasta reads ~/.pasta80.cfg to find its runtime
# directory and the assembler (PATH detection alone misses the rtl home).
RUN addgroup -g 1001 -S appuser \
    && adduser -u 1001 -S -G appuser -h /home/appuser -s /sbin/nologin appuser \
    && printf 'PASTA     = /opt/pasta80\nASSEMBLER = /usr/local/bin/sjasmplus\n' \
        > /home/appuser/.pasta80.cfg \
    && chown appuser:appuser /home/appuser/.pasta80.cfg

WORKDIR /app
COPY --chown=appuser:appuser . /app/
USER appuser

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:80/health', timeout=3).status==200 else 1)"

# pasta runs with its temp dir as CWD and writes only under /tmp (a writable
# tmpfs), so /app stays read-only. --limit-concurrency sheds a request flood
# as 503 rather than exhausting threads/memory (the compile endpoint is sync,
# so each in-flight request holds a threadpool slot and may spawn the
# compiler + assembler).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80", "--limit-concurrency", "12"]
