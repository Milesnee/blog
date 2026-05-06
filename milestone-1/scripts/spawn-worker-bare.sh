#!/usr/bin/env bash
# spawn-worker-bare.sh <user_id>
#
# Spawn a worker WITHOUT sandbox. Use only for baseline measurement to
# isolate sandbox overhead from worker memory. Not for production.
set -euo pipefail

USER_ID=${1:?usage: spawn-worker-bare.sh <user_id>}
DATA_DIR=${MILESTONE1_DATA_DIR:-/tmp/milestone-1-data}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
REPO=${MILESTONE1_REPO:-$(dirname "$SCRIPT_DIR")}
NODE_BIN=${NODE_BIN:-/opt/node22/bin/node}

USER_DIR=$DATA_DIR/users/$USER_ID
[[ -d $USER_DIR/openclaw ]] || { echo "workspace not seeded: $USER_DIR" >&2; exit 1; }
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required}"

exec env -i \
  HOME="$USER_DIR" \
  USER_ID="$USER_ID" \
  WORKER_WORKSPACE="$USER_DIR" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
  NODE_ENV=production \
  "$NODE_BIN" "$REPO/worker/worker.mjs"
