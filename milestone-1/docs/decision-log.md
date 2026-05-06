# Decision Log — Milestone 1

Each entry: decision, alternatives considered, why this one, what would change our mind.

---

## D-001: Worker language = Node 22

**Decision:** Worker is JavaScript (ESM) on Node 22.

**Alternatives:** Python, Go, Rust.

**Why:**
- OpenClaw upstream is TypeScript/Node — staying in the same runtime avoids re-implementing skills/tools/protocol later
- Node baseline is 40–80 MB, well below the 300 MB per-worker budget
- `@anthropic-ai/sdk` for Node is first-class (streaming, typed errors, tool runner)

**Reverse if:** Scenario A baseline > 200 MB. That'd mean Node is using more than expected; would prompt a Go/Rust port.

---

## D-002: IPC = NDJSON over stdio

**Decision:** Each line on stdin is a request, each line on stdout is an event. stderr is for logs.

**Alternatives:** Unix domain socket, named pipes, HTTP loopback, gRPC, MessagePack on stdio.

**Why:**
- One worker is single-tenant and serial; concurrency primitives are wasted
- Bubblewrap pipes stdio through unmodified — no port allocation, no mount headaches
- Trivially debuggable with `cat` and `jq`
- JSON parsing overhead is negligible vs LLM API calls
- No framing protocol needed (newlines are sufficient because no message contains a literal newline once stringified)

**Reverse if:** We need bi-directional streaming where the gateway pushes interrupts to a turn already in flight. (We don't, in milestone 1; turns are atomic and SIGTERM is the cancel mechanism.)

---

## D-003: Sandbox = bubblewrap

**Decision:** `bwrap` for the primary sandbox.

**Alternatives:** Docker, gVisor (`runsc`), nsjail, firecracker, no sandbox.

**Why:**
- ~50 ms cold start (vs Docker's ~1 s) matters when WeChat enforces a 5-second response budget
- No daemon (vs Docker, podman) — one less moving part on the host
- Mature on Debian/Ubuntu, used by Flatpak in production
- `--die-with-parent` matches the worker manager lifecycle

**Reverse if:** A real customer asks for stricter isolation (e.g. running user-supplied skill code that does syscalls). Then gVisor or microVM. Worth noting: this is not a milestone 1 requirement.

---

## D-004: NOT unsharing net

**Decision:** Worker's network namespace is the host's. Egress to `api.anthropic.com` works directly.

**Alternatives:** Unshare net + bridge into a controlled namespace.

**Why:**
- Setting up a network namespace with proper DNS + a route to api.anthropic.com is non-trivial and reviewing the PR adds friction
- Egress control belongs in the proxy layer (milestone 4), not in the worker sandbox
- The bigger isolation property (filesystem, PID space, IPC) is preserved

**Reverse if:** A specific user's worker is observed making unexpected egress calls. Then we re-enable `--unshare-net` and route through a TUN-driven local proxy.

---

## D-005: PSS, not RSS

**Decision:** Memory budget is measured in PSS (Proportional Set Size), not RSS.

**Why:**
- Six Node processes share libc, libssl, libcurl, the V8 binary itself, and large parts of the heap-templated jit code. Counting these pages once per process (RSS) overstates total host memory by 50–200 MB per worker.
- PSS divides shared pages by the number of mappers, so summing PSS across all workers approximates real host memory cost.
- Available cheaply via `/proc/<pid>/smaps_rollup` (kernel ≥ 4.14).

**Reverse if:** PSS is unavailable on the deployment kernel. Then fall back to RSS minus a fixed estimate of shared pages.

---

## D-006: Default model in fixture = Haiku 4.5

**Decision:** The fixture template ships with `model: claude-haiku-4-5`.

**Alternatives:** `claude-opus-4-7` (the SDK skill's recommended default).

**Why:**
- Milestone 1 will burn thousands of test turns across 5 scenarios. Haiku is ~5× cheaper than Opus for input, ~5× cheaper for output.
- Memory profile is largely SDK-side, not model-side. The same Anthropic client object is used regardless of model. Haiku gets us valid PSS numbers for cents instead of dollars.
- Validator allows Opus 4.7 too — production users can override per-template.

**Reverse if:** We discover the SDK transmits significantly more state for streaming Opus responses. (No reason to expect that; both models go through the same `messages.stream` path.)

---

## D-007: No `effort` in the default config

**Decision:** Fixture template leaves `effort` unset.

**Why:**
- `effort` errors out on Haiku 4.5 and Sonnet 4.5 (skill notes: "Will error on Sonnet 4.5 / Haiku 4.5"). We default to Haiku, so we'd have to set it conditionally.
- Validator blocks `effort` on incompatible models with a clear error message.

**Reverse if:** We change the default model to Opus or Sonnet 4.6.

---

## D-008: No thinking enabled in milestone 1

**Decision:** No `thinking: {type: "adaptive"}` in the prototype.

**Why:**
- Adaptive thinking adds variable, non-trivial memory overhead during the response (the SDK buffers thinking blocks).
- Milestone 1 is about establishing a baseline, not the worst-case
- Production users will configure their own thinking strategy in milestone 6 templates

**Reverse if:** The user asks for it, or scenario B's API behavior diverges suspiciously without thinking (e.g. truncated answers).

---

## D-009: Top-level prompt caching, always on

**Decision:** Every request gets `cache_control: {type: "ephemeral"}` at the top level.

**Why:**
- The system prompt is stable per worker session. Caching it cuts ~80% of input cost on every turn after the first.
- Top-level form auto-caches the last cacheable block — no need to annotate individual content blocks
- 5-minute TTL is sufficient because the worker is single-user and turns happen close together
- Observable via `cache_read_input_tokens` in `turn_done.stats`

**Reverse if:** We see `cache_read_input_tokens: 0` despite repeated turns — that means a silent invalidator slipped into the prefix (a timestamp, a UUID). Audit per `shared/prompt-caching.md`.

---

## D-010: Atomic state writes, every turn, blocking

**Decision:** Each `turn_done` is preceded by a `writeFile(tmp) + rename` of the session state.

**Alternatives:** Write asynchronously, write on shutdown only, write every N turns.

**Why:**
- We want SIGKILL to be safe — if the worker dies right after `turn_done` is emitted, the state must already be on disk
- `rename` is atomic on local POSIX filesystems
- The cost is one small file write (~few KB) per turn — irrelevant compared to LLM call latency
- Simpler than reasoning about async write windows

**Reverse if:** Profile shows the rename dominates turn latency (it won't on local disk).

---

## D-011: Whitelist config validation, fail-closed

**Decision:** Validator rejects unknown effort values, unknown models, paths with `..`, oversized prompts.

**Why:**
- Users own their config files (per the user-asset commitment) but the worker chooses what's loadable
- Failing loudly on `init` is much better than silent misbehavior at turn time
- The whitelist is the milestone 1 sketch of the milestone 2 user-policy model

**Open questions:**
- Whether to allow user-defined `tools` arrays in milestone 2 (they'd need their own whitelist)
- Whether to support per-tier model whitelisting (free vs paid)
