# Milestone 1: Worker Prototype + Memory Validation

Single go/no-go: can we fit ~6 worker processes in a 4 GB host while talking to the Anthropic API? See `docs/milestone-1-design.md` for the full plan and `docs/decision-log.md` for the rationale behind every choice.

## What's here

```
milestone-1/
├── worker/                    # the worker process (Node 22 + ESM)
│   ├── worker.mjs             # NDJSON loop on stdin/stdout, signal handling
│   ├── config-validator.mjs   # whitelist-based config check
│   ├── llm-client.mjs         # Anthropic SDK wrapper (streaming + finalMessage)
│   └── state.mjs              # atomic load/save of session state
├── scripts/
│   ├── spawn-worker-bwrap.sh   # primary: bubblewrap sandbox
│   ├── spawn-worker-docker.sh  # alternative: docker (heavier)
│   ├── spawn-worker-bare.sh    # baseline: no sandbox (measurement only)
│   ├── worker.Dockerfile       # for docker variant
│   └── measure-pss.sh          # /proc/<pid>/smaps_rollup PSS sampler
├── harness/
│   ├── driver.mjs              # CLI entrypoint, runs scenarios A-E
│   ├── scenarios.mjs           # the five scenarios
│   ├── worker-process.mjs      # spawn + NDJSON wire wrapper
│   ├── measure.mjs             # measure-pss.sh wrapper + summarize
│   └── setup.mjs               # seed user workspaces from fixture
├── fixtures/
│   └── user-template/          # what gets copied to a new user's $HOME
│       └── openclaw/
│           ├── config.yaml
│           ├── prompts/system.md
│           └── skills/
└── docs/
    ├── milestone-1-design.md
    └── decision-log.md
```

## Prerequisites

- Linux host with kernel ≥ 4.18 (for `smaps_rollup`)
- Node 22+ (`/opt/node22/bin/node` on the test host)
- `bubblewrap` (`bwrap`) for the primary sandbox: `sudo apt-get install -y bubblewrap`
- An Anthropic API key in `ANTHROPIC_API_KEY`
- `docker` only if you want to test the docker variant

## Setup

```bash
cd milestone-1
npm install
export ANTHROPIC_API_KEY=...   # required for B/C/D/E
```

## Run scenarios

```bash
# All five with bwrap sandbox (default)
node harness/driver.mjs

# Specific scenarios
node harness/driver.mjs A
node harness/driver.mjs B C E

# Switch sandbox mode
MODE=bare node harness/driver.mjs A B    # baseline, no sandbox
MODE=docker node harness/driver.mjs B    # docker variant
```

Reports land in `reports/` as JSON plus per-worker PSS time series (TSV).

## Scenario summary

| Scenario | What it measures | Pass threshold |
|---|---|---|
| A | Cold start + 30s idle | peak PSS ≤ 150 MB |
| B | Single turn | peak PSS ≤ 250 MB |
| C | 20-turn long context | growth ≤ 30 MB across turns |
| D | 6 concurrent workers, one turn each | total peak ≤ 3.5 GB |
| E | Kill mid-turn, new worker resumes from saved state | resumes from prior turns |

## Manual smoke test

```bash
# Spawn one worker, talk to it by hand
mkdir -p /tmp/milestone-1-data/users/u1
cp -r fixtures/user-template/* /tmp/milestone-1-data/users/u1/

# Send NDJSON requests on stdin; read responses on stdout
./scripts/spawn-worker-bwrap.sh u1 <<EOF
{"type":"init","user_id":"u1","workspace":"/home/user"}
{"type":"turn","request_id":"r1","input":"Say hi in one short sentence."}
{"type":"shutdown"}
EOF
```

## Things to verify before trusting numbers

1. `bwrap --version` returns ≥ 0.6 (older versions miss `--ro-bind-try`)
2. `cat /proc/$$/smaps_rollup | grep Pss:` works on this host
3. `npm install` produced `node_modules/` (the bwrap script will refuse to start otherwise)
4. ANTHROPIC_API_KEY is valid (try a curl first if unsure)

## Out of scope for milestone 1

- The gateway / Worker Manager / routing layer — that's milestone 2
- Egress proxy + per-user quotas — milestone 4
- WeChat adapter — milestone 5
- Template sync — milestone 6
- cgroup memory limits at the worker level — added in milestone 2 once baseline is known
