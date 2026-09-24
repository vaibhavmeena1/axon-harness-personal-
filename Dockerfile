# Public Wolfi (Chainguard) multi-stage build for the Engram backend.
#
# The Wolfi base provides glibc and apk but not Python. Python 3.12 is installed
# explicitly in each stage so the interpreter version is controlled here.
#
# WHY Wolfi over Alpine: glibc means every native dep (uvloop, httptools, asyncpg,
# psycopg2-binary, Pillow, rapidfuzz, xxhash, psutil, pydantic-core, cryptography)
# installs from a prebuilt manylinux wheel — no rustup, no -dev headers, no source
# builds, and none of the musl band-aids the Alpine image needed.
# Wolfi's continuously-rebuilt packages also clear OS CVEs unfixable on Alpine/musl.
#
# BUILD CONTEXT: the repository root, because this image also builds and embeds the
# console frontend:
#
#   DOCKER_BUILDKIT=1 docker build \
#     --build-arg SERVICE_NAME=... .
#
# The console is a static Vite build with nothing to run, so serving it from this
# service keeps one origin, one deploy, and one version for the API and the UI.
#
# ---------- console: build the static frontend bundle ----------
# Alpine/musl is fine here: this stage only emits static JS/CSS/HTML and never
# reaches the runtime image, so the glibc reasoning above does not apply.
#
# $BUILDPLATFORM, not linux/amd64: the output is architecture-independent, so this
# stage runs natively on the build machine. Pinning it to amd64 would put the
# whole Node toolchain under QEMU emulation on an arm64 host (every Apple Silicon
# laptop here) for output that is byte-identical either way.
FROM --platform=$BUILDPLATFORM node:24-alpine AS console

WORKDIR /build

# corepack resolves the pnpm version pinned by package.json's `packageManager`.
RUN corepack enable

# Install dependencies first so edits to application source reuse this layer.
COPY apps/frontend/package.json apps/frontend/pnpm-lock.yaml apps/frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY apps/frontend/ ./

# config.json is git-ignored, so the image builds it from the checked-in template.
# The template already targets the backend's own origin with relative API URLs.
RUN cp config_template.json config.json && pnpm build

# ---------- builder: install Python + build tools and resolve the virtual environment ----------
FROM --platform=linux/amd64 cgr.dev/chainguard/wolfi-base:latest AS builder

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ARG SERVICE_NAME

# Wolfi apk (the base has no Python). python-3.12 pins the interpreter.
# build-base/openssl-dev/libffi-dev are insurance — on glibc every native dep
# installs from a prebuilt manylinux wheel, so nothing actually compiles.
# The openssh-* packages are split in Wolfi; keyscan records Bitbucket's host key
# for the SSH fetch below.
RUN apk add --no-cache \
    python-3.12 python-3.12-dev \
    build-base openssl-dev libffi-dev \
    curl

ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/0.11.7/install.sh | sh

# Install dbmate in the builder and copy the binary into runtime.
RUN curl -fsSL https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-amd64 \
    -o /usr/local/bin/dbmate && chmod +x /usr/local/bin/dbmate

WORKDIR /home/ubuntu/1mg/$SERVICE_NAME
COPY apps/backend/pyproject.toml apps/backend/uv.lock apps/backend/README.md ./
ENV VIRTUAL_ENV=/home/ubuntu/1mg/$SERVICE_NAME/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN uv sync --frozen --no-dev --python /usr/bin/python3.12 && rm -rf /root/.cache/uv

# ---------- runtime: minimal Wolfi base + python-3.12 + the resolved venv ----------
FROM --platform=linux/amd64 cgr.dev/chainguard/wolfi-base:latest AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ARG SERVICE_NAME

# Runtime libs only:
#   python-3.12  — the interpreter
#   libstdc++    — required by Rust/Cython/C++ wheels at runtime: pydantic-core,
#                  cryptography, uvloop, httptools, asyncpg, rapidfuzz, xxhash
#   ca-certificates — TLS (httpx, redis, qdrant-client, etc.)
#   tzdata       — timezone support
# Node is deliberately absent: only the console's built output is copied in.
RUN apk add --no-cache python-3.12 libstdc++ ca-certificates tzdata curl

RUN mkdir -p /home/ubuntu/1mg/$SERVICE_NAME/logs

WORKDIR /home/ubuntu/1mg/$SERVICE_NAME

ARG APP_UID=1001
ARG APP_GID=1001
ARG APP_USER=app-user
ARG APP_GROUP=app-group
RUN addgroup -g ${APP_GID} ${APP_GROUP} && \
    adduser -D -u ${APP_UID} -G ${APP_GROUP} ${APP_USER}
ENV VIRTUAL_ENV=/home/ubuntu/1mg/$SERVICE_NAME/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

COPY --from=builder $VIRTUAL_ENV $VIRTUAL_ENV
COPY --from=builder /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY apps/backend/ .

# The console bundle, served by the app at "/" (config.json's FRONTEND_DIR).
COPY --from=console /build/dist ./static

# Make deployment scripts executable
RUN chmod +x deployment/*.sh

RUN chown -R ${APP_USER}:${APP_GROUP} /home/ubuntu/1mg/$SERVICE_NAME
USER ${APP_USER}:${APP_GROUP}