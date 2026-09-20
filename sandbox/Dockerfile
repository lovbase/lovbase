# Must match @cloudflare/sandbox in package.json.
FROM docker.io/cloudflare/sandbox:0.12.9

# The base image already ships bun and node; add pi as the coding agent.
RUN npm install -g @mariozechner/pi-coding-agent@0.73.1

# The `lovbase` CLI pi uses to read the schema and query data (see tools/).
COPY tools/lovbase /usr/local/bin/lovbase
RUN chmod +x /usr/local/bin/lovbase

# Starter project copied into /workspace/app on first run.
COPY template /opt/template

# Install here, not at runtime. `.dockerignore` keeps the host's node_modules out — correct, since
# those are built for the host platform — but the consequence was that every cold sandbox ran a
# full `bun install` before it could do anything: 209MB across 287 packages, on the critical path
# of the user's first request. Doing it at build time bakes the tree into the image, so the copy
# on first run brings node_modules with it and the runtime install has nothing left to do.
RUN cd /opt/template && bun install --frozen-lockfile

# Local dev (wrangler dev) only routes ports declared here; production exposes programmatically.
EXPOSE 5173

WORKDIR /workspace
