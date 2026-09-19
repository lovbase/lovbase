#!/usr/bin/env bash
# Confirm the thing that just deployed is actually serving.
#
# `railway up --ci` returns when the build log ends, which is not the same as the container being
# up: a build can succeed and the process still fail to serve. That exact case happened here —
# Railway injects PORT=8080, the service domain was pointing at 3008, and the result was a green
# build, a SUCCESS deployment and a 502 for every request. A green pipeline has to mean the site
# answers, so this asks the site.
set -euo pipefail

: "${DEPLOY_URL:?}"

echo "→ waiting for $DEPLOY_URL"
for attempt in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$DEPLOY_URL/" 2>/dev/null) || true
  echo "   [$attempt] $code"
  if [ "$code" = "200" ]; then
    echo "✓ serving"
    exit 0
  fi
  sleep 10
done

echo "✗ $DEPLOY_URL never returned 200" >&2
exit 1
