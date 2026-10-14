# syntax=docker/dockerfile:1.7
# Wolfi (Chainguard) multi-stage build for the Axon backend.
#
# Both Python stages default to the internal Python 3.12.14 image. Public users
# can select the public Wolfi base with --build-arg PYTHON_BASE_IMAGE=...; see
# apps/backend/README.md#docker. Python is installed only when the base lacks it.
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
#   docker build --build-arg SERVICE_NAME=axon-backend \
#     -t axon-backend .
#
# Private builds require ECR authentication; there is no automatic FROM fallback.
ARG PYTHON_BASE_IMAGE=831059512818.dkr.ecr.ap-south-1.amazonaws.com/python:wolfi-3.12.14-r8
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

# ---------- builder: install build tools and resolve the virtual environment ----------
FROM --platform=linux/amd64 ${PYTHON_BASE_IMAGE} AS builder

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ARG SERVICE_NAME=axon-backend

# The internal base already includes Python; the public Wolfi base does not.
RUN if [ ! -x /usr/bin/python3.12 ]; then apk add --no-cache python-3.12; fi

# build-base/openssl-dev/libffi-dev are insurance — on glibc every native dep
# installs from a prebuilt manylinux wheel, so nothing actually compiles.
RUN apk add --no-cache build-base openssl-dev libffi-dev curl

ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/0.11.7/install.sh | sh

WORKDIR /home/ubuntu/1mg/$SERVICE_NAME
COPY apps/backend/pyproject.toml apps/backend/uv.lock apps/backend/README.md ./
ENV VIRTUAL_ENV=/home/ubuntu/1mg/$SERVICE_NAME/.venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

RUN uv sync --frozen --no-dev --python /usr/bin/python3.12 && rm -rf /root/.cache/uv

# ---------- runtime: selected Wolfi base + the resolved venv ----------
FROM --platform=linux/amd64 ${PYTHON_BASE_IMAGE} AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ARG SERVICE_NAME=axon-backend

RUN if [ ! -x /usr/bin/python3.12 ]; then apk add --no-cache python-3.12; fi

# Runtime libs only (Python is provided by the base or installed above):
#   libstdc++    — required by Rust/Cython/C++ wheels at runtime: pydantic-core,
#                  cryptography, uvloop, httptools, asyncpg, rapidfuzz, xxhash
#   ca-certificates — TLS (httpx, redis, qdrant-client, etc.)
#   tzdata       — timezone support
# Node is deliberately absent: only the console's built output is copied in.
RUN apk add --no-cache libstdc++ ca-certificates tzdata curl

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
COPY apps/backend/ .
# Keep the same installer that the CLI release publishes, at apps/cli's sibling path.
COPY apps/cli/install.sh /home/ubuntu/1mg/cli/install.sh

# The console bundle, served by the app at "/" (config.json's FRONTEND_DIR).
COPY --from=console /build/dist ./static

# Make deployment scripts executable
RUN chmod +x deployment/*.sh

RUN chown -R ${APP_USER}:${APP_GROUP} /home/ubuntu/1mg/$SERVICE_NAME
USER ${APP_USER}:${APP_GROUP}