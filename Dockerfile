FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS go-build

WORKDIR /workhorse/go
ARG BUILD_CONCURRENCY=4
ENV GOMAXPROCS=${BUILD_CONCURRENCY}
COPY go/ ./
# The build and module caches persist in the builder between image builds (SM-854). When go/
# changes, only the packages it changed recompile. The binary is the same either way.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -o /opt/workhorse-go-demo-worker ./examples/demo-worker

FROM rust:1.89.0-alpine@sha256:4b800f2e72e04be908e5f634c504c741bd943b763d1d8ad7b096cc340e1b5b46 AS rust-build

# The Alpine Rust image omits the C runtime objects that linking a procedural macro needs.
RUN apk add --no-cache musl-dev
WORKDIR /workhorse
ARG BUILD_CONCURRENCY=4
ENV CARGO_BUILD_JOBS=${BUILD_CONCURRENCY}
# Cargo needs every workspace member's manifest, so the whole rust/ tree comes along. The image tag
# pins the toolchain that rust-toolchain.toml names; that file stays out so rustup fetches nothing.
COPY Cargo.toml Cargo.lock ./
COPY rust/ ./rust/
# The registry and target caches persist in the builder between image builds, like the Go caches.
# The binary leaves the cached target directory in the same step, because the mount does not.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/workhorse/target \
    cargo build --locked --release -p workhorse-demo-worker \
  && cp target/release/workhorse-rust-demo-worker /opt/workhorse-rust-demo-worker

# The Ruby worker runs on the runtime stage's Alpine Ruby, so its gems install on that same base. The
# lockfile pins every gem and its checksum. pg's prebuilt musl gem carries libpq, so nothing compiles.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS ruby-build

RUN apk add --no-cache ruby ruby-bundler
WORKDIR /opt/workhorse-ruby
ARG BUILD_CONCURRENCY=4
# The Gemfile names the SDK through its gemspec, so the SDK's sources come along. The development
# group holds the test and Rails gems, which the worker never loads.
COPY ruby/Gemfile ruby/Gemfile.lock ruby/stablemates-workhorse.gemspec ./
COPY ruby/lib/ ./lib/
RUN bundle config set --local frozen true \
  && bundle config set --local without development \
  && bundle config set --local path /opt/workhorse-ruby/bundle \
  && bundle install --jobs ${BUILD_CONCURRENCY} --quiet
COPY ruby/examples/demo_worker.rb ./

FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv

FROM python:3.14-alpine@sha256:9e9fde4d32eedce0b661d9ab91e826b62dddf28e928c230ec55f1866cac66b01 AS python-build

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /workhorse
ARG BUILD_CONCURRENCY=4
ENV UV_CONCURRENT_DOWNLOADS=${BUILD_CONCURRENCY}
ENV UV_CONCURRENT_INSTALLS=${BUILD_CONCURRENCY}
COPY python/pyproject.toml python/uv.lock ./python/
RUN uv export \
      --project python \
      --locked \
      --no-dev \
      --no-emit-project \
      --quiet \
      --output-file /tmp/requirements.txt \
  && uv pip install \
      --require-hashes \
      --target /opt/workhorse-python \
      --requirement /tmp/requirements.txt
COPY python/src/workhorse/ /opt/workhorse-python/workhorse/

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

ARG BUILD_CONCURRENCY=4
ENV GOMAXPROCS=${BUILD_CONCURRENCY}
ENV PNPM_CONFIG_NETWORK_CONCURRENCY=${BUILD_CONCURRENCY}
ENV PNPM_CONFIG_MAX_SOCKETS=${BUILD_CONCURRENCY}

# V8 sizes every heap at 4288 MB whatever the host has, so compilers here can promise more memory
# than the machine building the image owns. Only this stage sets it, so the published image keeps
# Node's defaults.
ENV NODE_OPTIONS=--max-old-space-size=2048

WORKDIR /workhorse
# Install from the manifests alone, so the layer survives any commit that changes no dependency.
# Copying the whole checkout first reran the install on every commit (SM-858). Every workspace
# package.json belongs in this list, which scripts/docker-install-layer.test.ts checks. The Prisma
# schema is here because that package's `prepare` script runs `prisma generate` during install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/app/package.json dashboard/app/
COPY site/package.json site/
COPY typescript/adapter-conformance/package.json typescript/adapter-conformance/
COPY typescript/core/package.json typescript/core/
COPY typescript/dashboard-contract/package.json typescript/dashboard-contract/
COPY typescript/dashboard-server/package.json typescript/dashboard-server/
COPY typescript/dashboard/package.json typescript/dashboard/
COPY typescript/demo/package.json typescript/demo/
COPY typescript/drizzle/package.json typescript/drizzle/
COPY typescript/kysely/package.json typescript/kysely/
COPY typescript/knex/package.json typescript/knex/
COPY typescript/otel/package.json typescript/otel/
COPY typescript/prisma/package.json typescript/prisma/
COPY typescript/typeorm/package.json typescript/typeorm/
COPY typescript/prisma/prisma/schema.prisma typescript/prisma/prisma/
RUN pnpm install --frozen-lockfile
COPY . .
# Links the sources the first install did not have. It downloads nothing.
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build:runtime && pnpm --filter @stablemates/workhorse-demo build
# `--prod` drops the demo's devDependencies but still lets them satisfy optional peers. The
# dashboard facade is one, and core's optional peer on it would ship the facade with Vite and the
# React UI libraries. The image serves the prebuilt bundle, so remove the devDependencies first.
RUN cd typescript/demo && npm pkg delete devDependencies
RUN pnpm --filter @stablemates/workhorse-demo deploy --prod --legacy /opt/workhorse-demo

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

ENV NODE_ENV=production
ENV PORT=3000
# This ceiling and the deployment's 1 GiB container memory limit are one pair; see the resource
# section of typescript/demo/DEPLOYMENT.md before changing either. V8 sizes a heap from a fixed
# default rather than from the container, so without this every Node process here believes it may
# grow to 4288 MB. It then defers collection until the container limit is reached first and the
# kernel kills the process with no message and no stack. The container runs four Node processes —
# the supervisor, the server, the TypeScript worker, and the staging worker — and each also holds
# about 80 MiB outside the heap, so four ceilings plus the Python, Go, Rust, and Ruby workers must
# fit 1 GiB.
ENV NODE_OPTIONS=--max-old-space-size=128
ENV WORKHORSE_DEMO_MODE=production
ENV WORKHORSE_DEMO_LOG_DIRECTORY=/opt/workhorse-demo/logs
ENV PYTHONPATH=/opt/workhorse-python

WORKDIR /opt/workhorse-demo
COPY --from=build --chown=node:node /opt/workhorse-demo/ ./
COPY --from=go-build /opt/workhorse-go-demo-worker /usr/local/bin/workhorse-go-demo-worker
COPY --from=rust-build /opt/workhorse-rust-demo-worker /usr/local/bin/workhorse-rust-demo-worker
COPY --from=python-build /opt/workhorse-python /opt/workhorse-python
COPY --from=ruby-build /opt/workhorse-ruby /opt/workhorse-ruby
COPY --chown=node:node python/examples/demo_worker.py /opt/workhorse-python-worker.py
RUN apk add --no-cache libpq python3 ruby ruby-bundler
RUN mkdir logs && chown node:node logs

USER node
EXPOSE 3000

# The source commit the dashboard shows beside the version. The build context excludes `.git`, so
# whoever builds the image passes it; left empty, the dashboard shows the version alone. It comes
# after every filesystem layer, so a new commit rebuilds none of them.
ARG WORKHORSE_REVISION=""
ENV WORKHORSE_REVISION=${WORKHORSE_REVISION}

CMD ["node", "container-entrypoint.mjs"]
