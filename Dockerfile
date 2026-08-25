FROM golang:1.25-alpine AS go-build

WORKDIR /workhorse/go
COPY go/ ./
RUN CGO_ENABLED=0 go build -o /opt/workhorse-go-demo-worker ./examples/demo-worker

FROM python:3.14-alpine AS python-build

WORKDIR /workhorse
COPY python/ ./python/
RUN pip install --no-cache-dir --target /opt/workhorse-python ./python

FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /workhorse
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:runtime && pnpm --filter @workhorse-js/demo build
RUN pnpm --filter @workhorse-js/demo deploy --prod --legacy /opt/workhorse-demo

FROM node:24-alpine AS runtime

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
