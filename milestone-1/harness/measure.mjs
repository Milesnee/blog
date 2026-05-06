import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const MEASURE_SH = resolve(HERE, '../scripts/measure-pss.sh');

/**
 * Walk the process tree under `rootPid` and find the leaf `node` process
 * running our worker. Bwrap wraps node in two parent processes (the bwrap
 * monitor and the namespace-init bwrap); we want the node leaf only — that's
 * where the real worker memory lives.
 *
 * Polls a few times because node may not have spawned yet immediately after
 * `spawn(script)`.
 */
export async function findWorkerPid(rootPid, { timeoutMs = 4000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = walkForWorker(rootPid);
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return rootPid; // fall back to the root; better something than nothing
}

function walkForWorker(pid) {
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    let comm = '';
    let cmdline = '';
    try { comm = readFileSync(`/proc/${cur}/comm`).toString().trim(); } catch {}
    try { cmdline = readFileSync(`/proc/${cur}/cmdline`).toString().replace(/\0/g, ' '); } catch {}
    if (comm === 'node' && /worker\.mjs/.test(cmdline)) return cur;
    let children = '';
    try { children = readFileSync(`/proc/${cur}/task/${cur}/children`).toString(); } catch {}
    for (const c of children.trim().split(/\s+/).filter(Boolean)) stack.push(Number(c));
  }
  return null;
}

/**
 * Start a measure-pss.sh subprocess that polls /proc/<pid>/smaps_rollup.
 * Returns a handle with .stop() and .read() methods.
 *
 * Pass the *worker node pid* (use findWorkerPid first), not the bwrap
 * wrapper — bwrap is < 1 MB and would dilute the signal.
 */
export function startMeasure(pid, outputPath, { intervalSec = 1 } = {}) {
  let proc;
  return {
    async start() {
      await mkdir(dirname(outputPath), { recursive: true });
      proc = spawn('bash', [MEASURE_SH, String(pid), outputPath, String(intervalSec)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      proc.stderr.on('data', (c) => process.stderr.write(`[measure ${pid}] ${c}`));
      // Give the sampler a tick to start before the caller proceeds.
      await new Promise((r) => setTimeout(r, intervalSec * 1000 + 100));
    },
    async stop() {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch {}
      }
    },
    async read() {
      try {
        const raw = await readFile(outputPath, 'utf8');
        return raw.trim().split('\n').filter(Boolean).map((line) => {
          const [tsNs, pssKb] = line.split(/\s+/);
          return { tsNs: BigInt(tsNs), pssKb: Number(pssKb) };
        });
      } catch {
        return [];
      }
    },
  };
}

export function summarize(samples) {
  if (samples.length === 0) return { count: 0 };
  const pss = samples.map((s) => s.pssKb);
  const max = Math.max(...pss);
  const last = pss[pss.length - 1];
  const first = pss[0];
  const sum = pss.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    first_kb: first,
    last_kb: last,
    peak_kb: max,
    mean_kb: Math.round(sum / pss.length),
    growth_kb: last - first,
    duration_s: Number(samples[samples.length - 1].tsNs - samples[0].tsNs) / 1e9,
  };
}
