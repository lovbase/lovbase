#!/usr/bin/env bash
# Point the Railway service at an image and wait for that deployment to land.
#
# Railway's CLI cannot do this with a project token — `railway up` wants to upload a build context
# and `serviceConnect` needs account credentials — but the GraphQL API accepts a project token for
# exactly the two things needed here: set the image, then deploy. A project token is also the right
# credential to hand CI, since it reaches one project and nothing else in the account.
#
# Queries live in quoted heredocs rather than inline in the jq arguments. Nesting a GraphQL body
# inside single quotes inside a command substitution inside double quotes reads fine and is wrong:
# bash brace-expanded `{ a, b, c }` into three separate jq calls, and the first sign of it was a
# GraphQL syntax error from the server.
set -euo pipefail

: "${RAILWAY_TOKEN:?}" "${RAILWAY_ENVIRONMENT_ID:?}" "${RAILWAY_SERVICE_ID:?}" "${IMAGE:?}"

API=https://backboard.railway.com/graphql/v2

read -r -d '' Q_SET_IMAGE <<'GQL' || true
mutation($s: String!, $e: String!, $i: String!) {
  serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { source: { image: $i } })
}
GQL

read -r -d '' Q_DEPLOY <<'GQL' || true
mutation($s: String!, $e: String!) {
  serviceInstanceDeployV2(serviceId: $s, environmentId: $e)
}
GQL

read -r -d '' Q_STATUS <<'GQL' || true
query($id: String!) {
  deployment(id: $id) { status }
}
GQL

# Send a query with the service/environment ids already bound, plus any extra --arg pairs.
gql() {
  local query="$1"; shift
  local payload
  payload=$(jq -n --arg q "$query" --arg s "$RAILWAY_SERVICE_ID" --arg e "$RAILWAY_ENVIRONMENT_ID" "$@" \
    '{ query: $q, variables: ($ARGS.named | del(.q)) }')
  curl -sS -X POST "$API" \
    -H "Project-Access-Token: $RAILWAY_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$payload"
}

# A GraphQL error arrives with HTTP 200, so the body is the only place failure shows up.
check() {
  if printf '%s' "$1" | jq -e 'has("errors")' >/dev/null 2>&1; then
    echo "Railway API error:" >&2
    printf '%s' "$1" | jq -r '.errors[].message' >&2
    exit 1
  fi
}

echo "→ image: $IMAGE"
res=$(gql "$Q_SET_IMAGE" --arg i "$IMAGE")
check "$res"

res=$(gql "$Q_DEPLOY")
check "$res"
deployment=$(printf '%s' "$res" | jq -r '.data.serviceInstanceDeployV2 // empty')
[ -n "$deployment" ] || { echo "✗ no deployment id came back" >&2; exit 1; }
echo "→ deployment: $deployment"

# Wait for it, so a failed rollout fails the workflow instead of being reported as a green deploy.
for _ in $(seq 1 60); do
  sleep 10
  res=$(gql "$Q_STATUS" --arg id "$deployment")
  status=$(printf '%s' "$res" | jq -r '.data.deployment.status // "UNKNOWN"')
  echo "   $status"
  case "$status" in
    SUCCESS) echo "✓ deployed"; exit 0 ;;
    FAILED|CRASHED|REMOVED) echo "✗ deployment $status" >&2; exit 1 ;;
  esac
done

echo "✗ timed out waiting for the deployment" >&2
exit 1
