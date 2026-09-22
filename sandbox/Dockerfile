# Must match @cloudflare/sandbox in package.json.
FROM docker.io/cloudflare/sandbox:0.12.9

# The base image already ships bun and node; add pi as the coding agent.
RUN npm install -g @mariozechner/pi-coding-agent@0.73.1

# The `lovbase` CLI pi uses to read the schema and query data (see tools/).
COPY tools/lovbase /usr/local/bin/lovbase
RUN chmod +x /usr/local/bin/lovbase

# Pristine source, for the one case where the app directory is gone while the container is not:
# `destroy` drops it before releasing the instance. Source only — `.dockerignore` keeps the host's
# node_modules out, and this copy is never run in place.
COPY template /opt/template

# The app itself, at the path it runs from, with everything a cold container used to do before it
# could answer already done at build time:
#
#   - dependencies installed — 209MB across 287 packages, once here instead of on the critical
#     path of every first request;
#   - copied to /workspace/app — the old layout kept the template in /opt and copied it across on
#     first use, and that copy included node_modules, which is most of the time a fresh container
#     spent before the first tool call could return;
#   - Vite's dependency pre-bundle written — `vite dev` otherwise esbuilds react, base-ui, lucide
#     and the rest on its first start, and the cache key includes the project root, so a bundle
#     made anywhere but here would be thrown away.
#
# Whether a container is blank or holds a restored project is no longer "does package.json
# exist" — it always does now — but a marker written by whatever first puts real files here
# (see `OWNED` in src/app.ts).
COPY template /workspace/app
RUN cd /workspace/app && bun install --frozen-lockfile && node node_modules/vite/bin/vite.js optimize

# Local dev (wrangler dev) only routes ports declared here; production exposes programmatically.
EXPOSE 5173

WORKDIR /workspace
