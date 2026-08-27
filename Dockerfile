FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS go-build

WORKDIR /workhorse/go
COPY go/ ./
RUN CGO_ENABLED=0 go build -o /opt/workhorse-go-demo-worker ./examples/demo-worker

FROM ghcr.io/astral-sh/uv:0.8.9@sha256:cda9608307dbbfc1769f3b6b1f9abf5f1360de0be720f544d29a7ae2863c47ef AS uv

FROM python:3.14-alpine@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc AS python-build

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /workhorse
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

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /workhorse
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:runtime && pnpm --filter @stablemates/workhorse-demo build
RUN pnpm --filter @stablemates/workhorse-demo deploy --prod --legacy /opt/workhorse-demo

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime

ENV NODE_ENV=production
ENV PORT=3000
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
