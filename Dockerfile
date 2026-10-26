# The Alpine python3 package of the node:24-alpine base below. The python-build stage installs the
# Python dependencies with this interpreter, and the runtime stage runs the Python worker on it, so
# a compiled dependency such as rpds-py always matches the interpreter that imports it (SM-1674).
# Alpine keeps only the newest build of a package in its repository. When it publishes a Python
# fix, `apk add` can no longer find this version and the build stops; update the pin as
# typescript/demo/DEPLOYMENT.md describes.
ARG ALPINE_PYTHON_VERSION=3.14.8-r0

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
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS ruby-build

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

# The JVM worker's jars. The build reads the core's sources and the dashboard bundle that the core
# jar carries. The runtime stage needs no Gradle and no JDK, only the JRE stage below.
FROM gradle:9.8.1-jdk25-alpine@sha256:88b059d39a3971709550fc721c029b0c54ab785dfe4fa4169ae04017cf2c22a4 AS jvm-build

WORKDIR /workhorse
ARG BUILD_CONCURRENCY=4
ENV GRADLE_USER_HOME=/var/cache/gradle
COPY dashboard/v1/bundle/ ./dashboard/v1/bundle/
COPY jvm/ ./jvm/
# The Gradle caches persist in the builder between image builds, like the Go caches. The jars leave
# the build directory in the same step, so the stage keeps only what the runtime copies.
RUN --mount=type=cache,target=/var/cache/gradle \
    gradle --quiet --no-daemon --max-workers=${BUILD_CONCURRENCY} -p jvm :examples:programs:demoWorkerClassPath \
  && cp -r jvm/examples/programs/build/demo-worker /opt/workhorse-jvm

# The JRE that runs the JVM worker. Its tag is the Temurin release that mise.toml pins. It is an
# Alpine build, so it runs on the musl C library of the runtime stage's base.
FROM eclipse-temurin:25.0.4_7-jre-alpine@sha256:2ca9adf44f5c29d28ecd26cf92d75cc0c66b7f32bfd839a4439e363a8b428af8 AS jre

# The .NET worker, published framework-dependent and without an app host, so one build serves every
# architecture. The SDK tag is the version that mise.toml pins.
FROM mcr.microsoft.com/dotnet/sdk:10.0.402-alpine3.24@sha256:496914451b05ac5a24592024362ec370c3a2d3c3fe817f864e4aa55c4c194a56 AS dotnet-build

WORKDIR /workhorse
ARG BUILD_CONCURRENCY=4
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
COPY dotnet/ ./dotnet/
# The NuGet package cache persists in the builder between image builds, like the Go caches.
RUN --mount=type=cache,target=/root/.nuget/packages \
    dotnet publish dotnet/demo/Workhorse.DemoWorker \
      --configuration Release \
      --output /opt/workhorse-dotnet \
      -maxcpucount:${BUILD_CONCURRENCY} \
      -p:UseAppHost=false

# The .NET runtime that runs the .NET worker. It matches the runtime of the SDK above.
FROM mcr.microsoft.com/dotnet/runtime:10.0.13-alpine3.24@sha256:6a97a629f6c44e7263b41175e79cb9aeb1df631d3714e74e80a4ddd016258646 AS dotnet-runtime

FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

# The dependencies install on the runtime stage's base and its pinned python3, not on a Python
# image, so the build and the runtime use one interpreter. uv leaves its install lock in the target
# directory, and anyone can write that file, so the step removes it.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS python-build

ARG ALPINE_PYTHON_VERSION
RUN apk add --no-cache python3=${ALPINE_PYTHON_VERSION}
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /workhorse
ARG BUILD_CONCURRENCY=4
ENV UV_CONCURRENT_DOWNLOADS=${BUILD_CONCURRENCY}
ENV UV_CONCURRENT_INSTALLS=${BUILD_CONCURRENCY}
ENV UV_PYTHON_DOWNLOADS=never
COPY python/pyproject.toml python/uv.lock ./python/
RUN uv export \
      --project python \
      --locked \
      --no-dev \
      --no-emit-project \
      --quiet \
      --output-file /tmp/requirements.txt \
  && uv pip install \
      --python /usr/bin/python3 \
      --require-hashes \
      --target /opt/workhorse-python \
      --requirement /tmp/requirements.txt \
  && rm /opt/workhorse-python/.lock
COPY python/src/workhorse/ /opt/workhorse-python/workhorse/

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build

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
# package.json belongs in this list, which scripts/docker-install-layer.test.ts checks. The two Prisma
# schemas are here because the `prepare` scripts of their packages run `prisma generate` during
# install. typescript/prisma generates the Prisma 6 client, and adapter-conformance the Prisma 7 one.
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
COPY typescript/adapter-conformance/prisma/schema.prisma typescript/adapter-conformance/prisma/
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

FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime

ENV NODE_ENV=production
ENV PORT=3000
# This ceiling and the deployment's 1 GiB container memory limit are one pair; see the resource
# section of typescript/demo/DEPLOYMENT.md before changing either. V8 sizes a heap from a fixed
# default rather than from the container, so without this every Node process here believes it may
# grow to 4288 MB. It then defers collection until the container limit is reached first and the
# kernel kills the process with no message and no stack. The container runs four Node processes —
# the supervisor, the server, the TypeScript worker, and the staging worker — and each also holds
# about 80 MiB outside the heap, so four ceilings plus the Python, Go, Rust, Ruby, JVM, and .NET
# workers must fit 1 GiB. The JVM worker's heap, metaspace, and code cache ceilings are in
# container-entrypoint.mjs.
ENV NODE_OPTIONS=--max-old-space-size=80
ENV WORKHORSE_DEMO_MODE=production
ENV WORKHORSE_DEMO_LOG_DIRECTORY=/opt/workhorse-demo/logs
ENV PYTHONPATH=/opt/workhorse-python

WORKDIR /opt/workhorse-demo
# root owns the application code, the dependencies, and the worker sources, and the node user can
# only read them. A compromised process therefore cannot replace the code that the next restart
# loads (SM-1667). The log directory is the one path the node user writes.
COPY --from=build /opt/workhorse-demo/ ./
COPY --from=go-build /opt/workhorse-go-demo-worker /usr/local/bin/workhorse-go-demo-worker
COPY --from=rust-build /opt/workhorse-rust-demo-worker /usr/local/bin/workhorse-rust-demo-worker
COPY --from=python-build /opt/workhorse-python /opt/workhorse-python
COPY --from=ruby-build /opt/workhorse-ruby /opt/workhorse-ruby
COPY --from=jvm-build /opt/workhorse-jvm /opt/workhorse-jvm
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
COPY --from=dotnet-build /opt/workhorse-dotnet /opt/workhorse-dotnet
COPY --from=dotnet-runtime /usr/share/dotnet /usr/share/dotnet
COPY python/examples/demo_worker.py /opt/workhorse-python-worker.py
ARG ALPINE_PYTHON_VERSION
RUN apk add --no-cache libpq python3=${ALPINE_PYTHON_VERSION} ruby ruby-bundler
RUN mkdir logs && chown node:node logs

USER node
# The image build stops here if the runtime contract breaks: the interpreter is not the pinned
# version, a worker cannot load its SDK, the node user cannot write its log directory, or the node
# user can write any other file under the application paths. BusyBox find has no `-writable`, so
# a file fails the check when node owns it, its group is node, or anyone can write it. `-B` keeps
# Python from writing bytecode into the layer.
RUN set -eu \
  && python3 -B -c "import platform, sys; expected = sys.argv[1].split('-r')[0]; actual = platform.python_version(); sys.exit(0 if actual == expected else f'python3 is {actual}, the pin is {expected}')" "${ALPINE_PYTHON_VERSION}" \
  && python3 -B -c "import workhorse._contracts" \
  && BUNDLE_GEMFILE=/opt/workhorse-ruby/Gemfile ruby -rbundler/setup -e 'require "stablemates/workhorse"' \
  && node -e 'import("@stablemates/workhorse").then(() => import("@stablemates/workhorse-dashboard-server"))' \
  && /opt/java/openjdk/bin/java --dry-run -cp '/opt/workhorse-jvm/*' run.workhorse.examples.programs.DemoWorkerProgram \
  && dotnet_check="$(/usr/share/dotnet/dotnet /opt/workhorse-dotnet/Workhorse.DemoWorker.dll 2>&1 || true)" \
  && if [ "$dotnet_check" != "DATABASE_URL_PRIMARY is required" ]; then echo "The .NET worker did not start: $dotnet_check" >&2; exit 1; fi \
  && probe="logs/.write-probe-$$" && : > "$probe" && rm "$probe" \
  && if touch /opt/workhorse-demo/.write-probe 2>/dev/null; then echo "The node user can write /opt/workhorse-demo" >&2; exit 1; fi \
  && writable="$(find /opt/workhorse-demo /opt/workhorse-python /opt/workhorse-python-worker.py /opt/workhorse-ruby /opt/workhorse-jvm /opt/java/openjdk /opt/workhorse-dotnet /usr/share/dotnet /usr/local/bin/workhorse-go-demo-worker /usr/local/bin/workhorse-rust-demo-worker -path /opt/workhorse-demo/logs -prune -o ! -type l \( -user node -o -group node -o -perm -0002 \) -print)" \
  && if [ -n "$writable" ]; then echo "The node user can write application files:" >&2; echo "$writable" >&2; exit 1; fi
EXPOSE 3000

# The source commit the dashboard shows beside the version. The build context excludes `.git`, so
# whoever builds the image passes it; left empty, the dashboard shows the version alone. It comes
# after every filesystem layer, so a new commit rebuilds none of them.
ARG WORKHORSE_REVISION=""
ENV WORKHORSE_REVISION=${WORKHORSE_REVISION}

CMD ["node", "container-entrypoint.mjs"]
