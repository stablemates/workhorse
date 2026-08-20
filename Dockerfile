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

WORKDIR /opt/workhorse-demo
COPY --from=build --chown=node:node /opt/workhorse-demo/ ./
RUN mkdir logs && chown node:node logs

USER node
EXPOSE 3000

CMD ["node", "container-entrypoint.mjs"]
