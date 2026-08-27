FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS go-build

WORKDIR /workhorse/go
COPY go/ ./
RUN CGO_ENABLED=0 go build -o /opt/workhorse-go-demo-worker ./examples/demo-worker

FROM python:3.14-alpine@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc AS python-build

WORKDIR /workhorse
COPY python/ ./python/
RUN pip install --no-cache-dir --target /opt/workhorse-python ./python

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
