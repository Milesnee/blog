#!/usr/bin/env bash
# spawn-worker-docker.sh <user_id>
#
# Alternative sandbox using Docker. Heavier than bwrap (~per-container
# overhead, slower start) but useful when bwrap is unavailable or for
# stricter isolation.
#
# First run will pull node:22-slim (~50MB) and install deps inside the
# container. Subsequent runs reuse the image.
set -euo pipefail

USER_ID=${1:?usage: spawn-worker-docker.sh <user_id>}
DATA_DIR=${MILESTONE1_DATA_DIR:-/tmp/milestone-1-data}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
REPO=${MILESTONE1_REPO:-$(dirname "$SCRIPT_DIR")}
IMAGE=${WORKER_IMAGE:-openclaw-worker:milestone-1}

USER_DIR=$DATA_DIR/users/$USER_ID
[[ -d $USER_DIR/openclaw ]] || { echo "workspace not seeded: $USER_DIR" >&2; exit 1; }
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building image $IMAGE..." >&2
  docker build -t "$IMAGE" -f "$SCRIPT_DIR/worker.Dockerfile" "$REPO" >&2
fi

exec docker run --rm -i \
  --network host \
  --memory 400m \
  --cpus 0.5 \
  --pids-limit 64 \
  --read-only \
  --tmpfs /tmp \
  -v "$USER_DIR:/home/user" \
  -e USER_ID="$USER_ID" \
  -e WORKER_WORKSPACE=/home/user \
  -e HOME=/home/user \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e NODE_ENV=production \
  "$IMAGE"
