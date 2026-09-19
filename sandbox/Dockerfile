# Must match @cloudflare/sandbox in package.json.
FROM docker.io/cloudflare/sandbox:0.12.9

# The base image already ships bun and node; add pi as the coding agent.
RUN npm install -g @mariozechner/pi-coding-agent@0.73.1

# The `lovbase` CLI pi uses to read the schema and query data (see tools/).
COPY tools/lovbase /usr/local/bin/lovbase
RUN chmod +x /usr/local/bin/lovbase

# Starter project copied into /workspace/app on first run.
COPY template /opt/template

# Local dev (wrangler dev) only routes ports declared here; production exposes programmatically.
EXPOSE 5173

WORKDIR /workspace
