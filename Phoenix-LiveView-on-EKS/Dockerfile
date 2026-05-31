# syntax=docker/dockerfile:1.7
#
# Production image for the Phoenix LiveView demo (upstream:
# https://github.com/chrismccord/phoenix_live_view_example).
#
# Design notes — see README.md "Container" section for the long-form rationale.
#
# - Multi-stage: a fat Elixir/Erlang builder produces a self-contained OTP
#   release; the runtime stage only carries the release tree and the shared
#   libraries the BEAM actually links against.
# - Base image: debian:bookworm-slim, NOT alpine. The BEAM and several NIFs
#   (crypto, asn1) have a long history of subtle issues against musl libc —
#   primarily around DNS resolution (Erlang's inet_dns vs musl resolver) and
#   stack sizes for dirty schedulers. Glibc avoids that whole class of bugs
#   at the cost of ~20MB of image. Worth it for a connection-holding service.
# - PID 1 is the BEAM itself. The release runner script (`bin/demo start`)
#   uses `exec` to replace its shell process with `beam.smp`, so signals
#   (SIGTERM in particular) hit the VM directly. No tini, no dumb-init —
#   they would add a layer of signal forwarding for a process that already
#   handles signals correctly and reaps its own children.
# - Non-root runtime user (uid/gid 1001). Writable scratch dir only where
#   the release demands it; root filesystem is read-only at the K8s layer.
# - No secrets baked into any layer. SECRET_KEY_BASE, DATABASE_URL, and
#   RELEASE_COOKIE are supplied at runtime via env / projected secrets.

ARG ELIXIR_VERSION=1.14.5
ARG OTP_VERSION=25.3.2.14
ARG DEBIAN_VERSION=bullseye-20260518-slim
# Why pin this era: the upstream phoenix_live_view_example is a Phoenix
# 1.6 / Ecto 3.6 application whose mix.lock predates Elixir's built-in
# `dynamic/0` type (added in 1.17). Newer Elixir/OTP builders fail to
# compile that vintage of Ecto with a "type dynamic/0 is a built-in
# type and it cannot be redefined" error. 1.14.5/OTP 25.3 is the latest
# combination known to compile this dep tree cleanly.

ARG BUILDER_IMAGE="hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION}"
# Runtime base must share the builder's libc family because the release
# embeds ERTS compiled against the builder's shared libs. Bullseye ↔
# bookworm differ in libssl (1.1 vs 3.x), so we hold both stages on
# bullseye for now. When the upstream app modernises (Phoenix 1.7+,
# Ecto >= 3.10), we lift both ends to bookworm together.
ARG RUNNER_IMAGE="debian:bullseye-slim"

# ----------------------------------------------------------------------------
# Stage 1 — builder
# ----------------------------------------------------------------------------
FROM ${BUILDER_IMAGE} AS builder

# Build deps. git is needed for hex/rebar git deps; build-essential covers
# NIF compilation (crypto, bcrypt_elixir, etc.). curl is convenient for
# fetching tooling without leaving the layer.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends \
      build-essential \
      git \
      ca-certificates \
      curl \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

ENV MIX_ENV=prod \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /app

RUN mix local.hex --force \
 && mix local.rebar --force

# --- Dependency layer ----------------------------------------------------
# Copy only the dep manifests first so this layer caches across code changes.
COPY mix.exs mix.lock ./
COPY config/config.exs config/${MIX_ENV}.exs config/

RUN mix deps.get --only ${MIX_ENV}
RUN mix deps.compile

# --- Asset layer ---------------------------------------------------------
# esbuild is fetched as a runtime dep by the :esbuild package on first call
# during `mix assets.deploy`. The example app has no Tailwind.
COPY priv priv
COPY assets assets
RUN mix assets.deploy

# --- App compile + release ----------------------------------------------
COPY lib lib

# runtime.exs from the upstream phoenix_live_view_example is missing the
# one line that matters in a release: `server: true` on the Endpoint.
# We overlay our patched version (see patches/runtime.exs and
# patches/README.md). This is the only upstream file we modify.
COPY patches/runtime.exs config/runtime.exs

RUN mix compile

# A release is what we actually ship: pruned BEAM tree + embedded ERTS so
# the runtime image needs no Erlang/Elixir packages.
#
# We do NOT `COPY rel rel/` because the upstream example doesn't ship a
# `rel/` directory, and `mix release` works without one (it falls back to
# the implicit defaults). If you fork and add release overlays (vm.args,
# env.sh, hooks), re-introduce the COPY here.
RUN mix release

# ----------------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------------
FROM ${RUNNER_IMAGE} AS runtime

# Shared libs BEAM links against at runtime. We do NOT need erlang here —
# `mix release` bundled ERTS into the release tree.
#   libstdc++6  : NIFs compiled with C++
#   libssl3     : :crypto / :ssl
#   libncurses6 : runtime IEx (kept for `bin/demo remote`)
#   locales     : prevent C.UTF-8 surprises in Logger
#   tzdata      : :calendar / Timex-style time handling
#   openssl     : runtime tooling (cert verify, key gen)
#   ca-certificates : RDS in GovCloud requires the cert bundle
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends \
      libstdc++6 \
      libssl1.1 \
      libncurses6 \
      locales \
      tzdata \
      openssl \
      ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
 && locale-gen

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    LANGUAGE=en_US:en

# Non-root runtime user. Fixed uid/gid so volume mounts and SCCs in
# regulated clusters behave predictably.
RUN groupadd --system --gid 1001 app \
 && useradd  --system --uid 1001 --gid 1001 --home-dir /app --shell /sbin/nologin app

WORKDIR /app

# Copy the release tree owned by the runtime user. The app name `demo`
# comes from upstream mix.exs (`app: :demo`). If you fork and rename,
# rebuild with --build-arg APP_NAME=… (see below).
ARG APP_NAME=demo
ENV APP_NAME=${APP_NAME}

COPY --from=builder --chown=app:app /app/_build/prod/rel/${APP_NAME} ./

USER app:app

# Pull all configuration from the environment at runtime. None of these
# values are baked into the image.
ENV PHX_SERVER=true \
    PORT=4000 \
    ERL_AFLAGS="-proto_dist inet_tcp" \
    HOME=/app

EXPOSE 4000

# Note: this exec-form CMD invokes the release runner directly. The runner
# script in turn execs into beam.smp, so the BEAM ends up as PID 1.
# We intentionally don't wrap with tini — see header.
CMD ["/bin/sh", "-c", "exec /app/bin/${APP_NAME} start"]
