#!/usr/bin/env bash
# measure-pss.sh <pid> <output_file> [interval_seconds]
#
# Sample PSS (Proportional Set Size) from /proc/<pid>/smaps_rollup once per
# interval. Writes "<unix_ts> <pss_kb>" lines until pid dies or this script
# is killed. PSS is the right metric for multi-worker scenarios because it
# accounts for shared pages (libc, openssl, node runtime).
set -euo pipefail

PID=${1:?usage: measure-pss.sh <pid> <output_file> [interval]}
OUT=${2:?missing output file}
INTERVAL=${3:-1}

[[ -e /proc/$PID/smaps_rollup ]] || {
  echo "no smaps_rollup for pid $PID (already exited?)" >&2
  exit 1
}

while [[ -e /proc/$PID/smaps_rollup ]]; do
  pss=$(awk '/^Pss:/ {print $2; exit}' "/proc/$PID/smaps_rollup" 2>/dev/null || echo "")
  if [[ -n $pss ]]; then
    printf '%d %s\n' "$(date +%s%N)" "$pss" >> "$OUT"
  fi
  sleep "$INTERVAL"
done
