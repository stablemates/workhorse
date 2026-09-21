FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS go-build

WORKDIR /workhorse/go
ARG BUILD_CONCURRENCY=4
ENV GOMAXPROCS=${BUILD_CONCURRENCY}
COPY go/ ./
RUN CGO_ENABLED=0 go build -o /opt/workhorse-go-demo-worker ./examples/demo-worker

FROM ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc AS uv

FROM python:3.14-alpine@sha256:016508ba505da24f7139765bc4bb669df4e88eb2f12eeadd571bf2f88d7533df AS python-build

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
COPY . .
RUN pnpm install --frozen-lockfile
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
# about 80 MiB outside the heap, so four ceilings plus the Python and Go workers must fit 1 GiB.
ENV NODE_OPTIONS=--max-old-space-size=128
ENV WORKHORSE_DEMO_MODE=production
ENV WORKHORSE_DEMO_LOG_DIRECTORY=/opt/workhorse-demo/logs
ENV PYTHONPATH=/opt/workhorse-python

WORKDIR /opt/workhorse-demo
COPY --from=build --chown=node:node /opt/workhorse-demo/ ./
COPY --from=go-build /opt/workhorse-go-demo-worker /usr/local/bin/workhorse-go-demo-worker
COPY --from=python-build /opt/workhorse-python /opt/workhorse-python
COPY --chown=node:node python/examples/demo_worker.py /opt/workhorse-python-worker.py
RUN apk add --no-cache libpq python3
RUN mkdir logs && chown node:node logs

USER node
EXPOSE 3000

CMD ["node", "container-entrypoint.mjs"]
