#!/usr/bin/env bash
# spawn-worker-bwrap.sh <user_id>
#
# Spawn a worker process in a bubblewrap sandbox with the user's workspace
# mounted at /home/user. Worker reads NDJSON from stdin, writes NDJSON to
# stdout, logs to stderr.
#
# Required env (at least one provider key, depending on the user's region):
#   ANTHROPIC_API_KEY    overseas users (Claude)
#   DEEPSEEK_API_KEY     cn-mainland users (DeepSeek)
#   DOUBAO_API_KEY       cn-mainland users (Volcengine ARK / Doubao)
# Optional env:
#   MILESTONE1_DATA_DIR  user data root, default /tmp/milestone-1-data
#   MILESTONE1_REPO      milestone-1 repo dir, default = parent of this script
#   NODE_BIN             default /opt/node22/bin/node
set -euo pipefail

USER_ID=${1:?usage: spawn-worker-bwrap.sh <user_id>}
DATA_DIR=${MILESTONE1_DATA_DIR:-/tmp/milestone-1-data}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
REPO=${MILESTONE1_REPO:-$(dirname "$SCRIPT_DIR")}
NODE_BIN=${NODE_BIN:-/opt/node22/bin/node}
NODE_PREFIX=$(dirname "$(dirname "$NODE_BIN")")

USER_DIR=$DATA_DIR/users/$USER_ID
if [[ ! -d $USER_DIR/openclaw ]]; then
  echo "user workspace not seeded: $USER_DIR" >&2
  exit 1
fi
if [[ ! -d $REPO/node_modules ]]; then
  echo "node_modules missing in $REPO; run 'npm install' first" >&2
  exit 1
fi

# At least one provider key must be present; the worker will fail at init
# if the user's config requires an unset provider's key.
if [[ -z ${ANTHROPIC_API_KEY:-} && -z ${DEEPSEEK_API_KEY:-} && -z ${DOUBAO_API_KEY:-} ]]; then
  echo "no provider API key set (need at least one of ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, DOUBAO_API_KEY)" >&2
  exit 1
fi

exec bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind /etc/ssl /etc/ssl \
  --ro-bind-try /etc/ca-certificates /etc/ca-certificates \
  --ro-bind-try /etc/hosts /etc/hosts \
  --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \
  --ro-bind "$NODE_PREFIX" "$NODE_PREFIX" \
  --ro-bind "$REPO" /opt/openclaw-worker \
  --bind "$USER_DIR" /home/user \
  --proc /proc --dev /dev --tmpfs /tmp \
  --unshare-pid --unshare-ipc --unshare-uts \
  --hostname "worker-$USER_ID" \
  --clearenv \
  --setenv HOME /home/user \
  --setenv USER worker \
  --setenv USER_ID "$USER_ID" \
  --setenv WORKER_WORKSPACE /home/user \
  --setenv ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}" \
  --setenv DEEPSEEK_API_KEY "${DEEPSEEK_API_KEY:-}" \
  --setenv DOUBAO_API_KEY "${DOUBAO_API_KEY:-}" \
  --setenv ARK_API_KEY "${ARK_API_KEY:-}" \
  --setenv DEEPSEEK_BASE_URL "${DEEPSEEK_BASE_URL:-}" \
  --setenv DOUBAO_BASE_URL "${DOUBAO_BASE_URL:-}" \
  --setenv NODE_ENV production \
  --setenv PATH "$NODE_PREFIX/bin:/usr/bin:/bin" \
  --die-with-parent --new-session \
  -- "$NODE_BIN" /opt/openclaw-worker/worker/worker.mjs
