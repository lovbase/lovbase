# Sandbox image for the self-hosted runner (no Cloudflare base). Build from the sandbox/ directory:
#   docker build -f runner/Dockerfile -t lovbase-sandbox:local .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.3 @mariozechner/pi-coding-agent@0.73.1
COPY tools/lovbase /usr/local/bin/lovbase
RUN chmod +x /usr/local/bin/lovbase
COPY template /opt/template
WORKDIR /workspace
EXPOSE 5173
CMD ["sleep", "infinity"]
