# Milestone 1 — Design

## Single goal

Validate the core memory budget assumption underpinning the multi-user openclaw gateway: **can ~6 worker processes coexist within a 4 GB host while talking to the Anthropic API?**

Failure here invalidates the architecture; everything downstream depends on the per-worker memory footprint.

## Decision tree (from results)

| Worker steady PSS | Action |
|---|---|
| ≤ 150 MB | MAX_ACTIVE can grow to 8+ |
| 150–250 MB | MAX_ACTIVE = 6 (planned) |
| 250–350 MB | MAX_ACTIVE = 4, downgrade target |
| 350–500 MB | MAX_ACTIVE = 4 + plan 8 GB host |
| > 500 MB | Reconsider implementation; Node may be too heavy or there's a leak |

## Worker contract (NDJSON over stdio)

Chosen over Unix sockets / HTTP because:
- One worker = one user = serial = no socket-level concurrency needed
- Stdio is sandbox-transparent (bwrap pipes through; no port allocation)
- `cat | tee` makes debugging trivial
- IPC overhead is essentially zero

### Wire protocol

Every line is a JSON object terminated by `\n`. stderr carries human/JSON logs separately.

Driver → Worker:
```
{"type":"init","user_id":"u_123","workspace":"/home/user"}
{"type":"turn","request_id":"r_001","input":"<user message>"}
{"type":"shutdown"}
```

Worker → Driver:
```
{"type":"ready","model":"...","resumed_turns":N}
{"type":"turn_chunk","request_id":"r_001","delta":"..."}    # streamed text
{"type":"turn_done","request_id":"r_001","stats":{...}}
{"type":"error","request_id":"r_001","error":"...","kind":"..."}
```

### Lifecycle invariants

- One in-flight turn at a time. Pipelining is rejected with an error.
- `SIGTERM` enters drain mode: refuse new requests, finish current turn, exit.
- `SIGKILL` is acceptable; the most recent in-flight turn is lost but state from prior turns survives because each `turn_done` writes state atomically before emitting.
- Worker exits on stdin close.

## Sandbox

`bwrap` selected over Docker / nsjail / gVisor:
- ~50 ms cold start vs Docker's seconds
- No daemon
- Fits the per-worker model — one bwrap invocation per worker
- Sufficient isolation for the threat model (user can write only inside `users/{uid}/`, can't see other users' filesystems, can't see other workers' processes via `--unshare-pid`)

The launch script binds:
- `/usr`, `/lib`, `/lib64`, `/etc/{resolv.conf,hosts,nsswitch.conf,ssl}` read-only
- Node prefix read-only
- Repo's `milestone-1/` read-only at `/opt/openclaw-worker`
- `users/{uid}/` read-write at `/home/user`
- Fresh `/proc`, `/dev`, `/tmp`
- New PID/IPC/UTS namespaces
- Inherited net namespace (worker needs egress to `api.anthropic.com`)

We deliberately do **not** unshare net in milestone 1; in milestone 4 the egress proxy will handle that with cgroup-routed iptables.

## State serialization

`users/{uid}/session/current.json` written atomically (`writeFile(tmp)` + `rename`) at the end of each turn. Schema is versioned (`version: 1`).

Worker can be killed at any moment; restart loads the file and `resumed_turns` is non-zero. This is the foundation for the LRU eviction strategy in milestone 2 — long sessions can be paged out to disk.

## Anthropic SDK usage

Per the `claude-api` skill guidance:

- Default model `claude-opus-4-7`. Fixture uses `claude-haiku-4-5` instead because milestone 1 is throwing away thousands of test turns and Haiku is the cheapest sane model. The validator whitelists both.
- **Streaming** with `client.messages.stream()` plus `await stream.finalMessage()`. Avoids HTTP timeouts at any `max_tokens`, gives us per-token deltas to forward as `turn_chunk` events.
- **Top-level `cache_control: {type: "ephemeral"}`** on every request. Caches the system prompt automatically. Hit rate is observable in `usage.cache_read_input_tokens` reported by `turn_done`.
- `effort` parameter is gated by model: only Opus 4.5+ and Sonnet 4.6 accept it. Validator enforces.
- No `temperature` / `top_p` / `top_k`: removed on Opus 4.7 anyway, and irrelevant for measuring memory.
- No thinking enabled. Adaptive thinking would add real but variable memory pressure; deliberately keeping the prototype to a baseline. Easy to add via config later.
- Errors caught with `instanceof Anthropic.APIError`, surfaced as `{type:"error",kind:"api_error",status:NNN}` to the driver.

## Config validation (whitelist, fail-closed)

The validator rejects:
- Models not in the whitelist
- `max_tokens` outside `[64, 32000]`
- `effort` on incompatible models
- Absolute paths or `..` in `system_prompt`
- System prompts > 200 KB
- Any unknown `effort` value

This is the foundation for the milestone 2 user-config policy: the user owns the file, but the worker enforces what is loadable. Changes to user config don't crash the worker — they fail init with a structured error.

## Test scenarios

| Scenario | Method | What it tells us |
|---|---|---|
| **A** | Spawn → ready → 30 s idle | Idle baseline (Node + SDK + parsed config + Anthropic client). Can't do anything useful below this number. |
| **B** | Single representative turn (~200 token in, ~500 out) | Realistic operating PSS during/after a turn. Working set during streaming. |
| **C** | 20 turns of incremental story-building | Detect memory leaks: PSS should plateau as the messages array grows but JS GC reclaims string allocations from streaming. Linear growth = leak (or unbounded message accumulation — needs compaction). |
| **D** | 6 concurrent workers each running B | The actual gateway test. Sum of per-worker PSS + system overhead must fit in 4 GB. |
| **E** | 5 turns, SIGKILL mid-turn 6, spawn new worker, run "turn 7" | Verifies the LRU eviction story. Worker B must report `resumed_turns: 5` from `init`, then continue conversationally. |

## Why we use PSS, not RSS

In scenario D, six worker processes share the same Node binary, libc, libssl, libcurl, etc. Counting RSS (which includes shared pages per-process) double-counts ~50–200 MB of shared memory and overstates the budget. PSS (Proportional Set Size) divides each shared page by the number of processes mapping it, giving an accurate "this much RAM does the system actually need" figure.

Source: `/proc/<pid>/smaps_rollup` is the cheap aggregate path (kernel ≥ 4.14).

## What this milestone deliberately does NOT do

- No worker manager (LRU pool, lifecycle) — milestone 2
- No egress proxy / quotas — milestone 4
- No cgroup memory limits — milestone 2 (after we know the baseline)
- No template sync logic — milestone 6
- No WeChat adapter — milestone 5
- No tools / skills beyond a system prompt — keeps the memory measurement honest by not introducing variables we'd then want to factor out

## Pass condition for the milestone

Run all five scenarios end to end. Write the resulting `report-*.json`. Compare each scenario's `pass: bool` to the targets table in the design above. If D fails, MAX_ACTIVE in milestone 2 is recalibrated. If C shows linear growth, add compaction (`compact-2026-01-12` beta header) before milestone 2.
