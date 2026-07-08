# sjasmplus toolchain, built from the pinned release tarball. USE_LUA=0 drops
# the embedded Lua scripting engine entirely — this service assembles
# untrusted input, and the LUA directive would otherwise run arbitrary
# scripts inside the container.
FROM alpine:3.22 AS toolchain
RUN apk add --no-cache build-base curl xz
ARG SJASMPLUS_VERSION=1.23.1
ARG SJASMPLUS_SHA256=0203a01199b16660027fbe04b0a87dc5aff299401b5e3e49bff8468a3801cc54
RUN curl -fsSL -o /tmp/sjasmplus-src.tar.xz \
        "https://github.com/z00m128/sjasmplus/releases/download/v${SJASMPLUS_VERSION}/sjasmplus-${SJASMPLUS_VERSION}-src.tar.xz" \
    && echo "${SJASMPLUS_SHA256}  /tmp/sjasmplus-src.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/sjasmplus-src.tar.xz -C /tmp \
    && make -C "/tmp/sjasmplus-${SJASMPLUS_VERSION}" USE_LUA=0 -j"$(nproc)" \
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
    PYTHONUNBUFFERED=1

# Non-root, no login shell.
RUN addgroup -g 1001 -S appuser \
    && adduser -u 1001 -S -G appuser -h /home/appuser -s /sbin/nologin appuser

WORKDIR /app
COPY --chown=appuser:appuser . /app/
# Ensure the working dir itself is writable by the non-root user (WORKDIR
# creates it owned by root).
RUN chown appuser:appuser /app
USER appuser

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:80/health', timeout=3).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "80"]
