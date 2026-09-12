ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}

USER root
RUN mkdir -p /app/dist \
    && ln -s /opt/workhorse-demo/node_modules /app/node_modules
COPY --chmod=755 typescript/core/test/fixtures/kubernetes-smoke/workhorse /usr/local/bin/workhorse
COPY --chown=node:node typescript/core/test/fixtures/kubernetes-smoke/worker.mjs /app/dist/workhorse.worker.js
COPY --chown=node:node typescript/core/test/fixtures/kubernetes-smoke/client.mjs /app/client.mjs

WORKDIR /app
USER node
