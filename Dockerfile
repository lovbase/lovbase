# Main app image: one Node process serving the NestJS backend (api/), the built client and SSR.
# Build with Bun, run with Node, next to Postgres. The sandbox that runs generated apps is a
# separate service (sandbox/), not this image.
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY api/package.json api/
COPY app/package.json app/
COPY core/package.json core/
COPY sandbox/package.json sandbox/
RUN bun install --frozen-lockfile

COPY core core
COPY sandbox/src sandbox/src
COPY api api
# rspack bundles the backend (SWC emits the decorator metadata Nest's DI needs) and tsc emits the
# types the web app compiles against. The app build has to come second: it imports @lovbase/api.
RUN cd api && bun run build

COPY app app
# Anything the browser bundle needs is inlined by `vite build`, so it has to exist at BUILD time —
# a runtime service variable arrives far too late. Docker will not pass one through without an
# explicit ARG, which is why setting VITE_* on the host alone silently does nothing.
ARG VITE_POSTHOG_KEY=""
ARG VITE_POSTHOG_HOST=""
ARG VITE_GITHUB_URL=""
ENV VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    VITE_GITHUB_URL=$VITE_GITHUB_URL
RUN cd app && bun run build

FROM node:22-slim
ENV NODE_ENV=production
# Bun installs into a shared store at the workspace root and symlinks each package's node_modules
# into it, so the runtime keeps the same relative layout: /srv/node_modules + /srv/{api,app,core}.
WORKDIR /srv/app
COPY --from=build /src/node_modules /srv/node_modules
COPY --from=build /src/core /srv/core
COPY --from=build /src/api/node_modules /srv/api/node_modules
COPY --from=build /src/api/package.json /srv/api/
COPY --from=build /src/api/dist /srv/api/dist
COPY --from=build /src/app/node_modules ./node_modules
COPY --from=build /src/app/package.json /src/app/server.mjs ./
COPY --from=build /src/app/dist ./dist
EXPOSE 3008
CMD ["node", "server.mjs"]
