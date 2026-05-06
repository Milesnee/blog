import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPO = resolve(HERE, '..');
const SCRIPTS = resolve(REPO, 'scripts');

const SCRIPT_BY_MODE = {
  bwrap: 'spawn-worker-bwrap.sh',
  bare: 'spawn-worker-bare.sh',
  docker: 'spawn-worker-docker.sh',
};

export class Worker {
  constructor(userId, { mode = 'bwrap' } = {}) {
    this.userId = userId;
    this.mode = mode;
    this.script = resolve(SCRIPTS, SCRIPT_BY_MODE[mode] || SCRIPT_BY_MODE.bwrap);
    this.proc = null;
    this.pid = null;
    this.events = [];
    this.pendingResolves = [];
    this.exited = null;
  }

  spawn() {
    this.proc = spawn(this.script, [this.userId], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MILESTONE1_REPO: REPO },
    });
    this.pid = this.proc.pid;

    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const ev = JSON.parse(line);
        this.events.push(ev);
        const next = this.pendingResolves.shift();
        if (next) next(ev);
      } catch (e) {
        process.stderr.write(`[worker stdout non-json] ${line}\n`);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[worker:${this.userId}] ${chunk}`);
    });

    this.exited = new Promise((res) => {
      this.proc.on('exit', (code, signal) => res({ code, signal }));
    });
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Resolve when the next event of one of `types` arrives. */
  waitFor(types, { timeoutMs = 120_000 } = {}) {
    const set = new Set(Array.isArray(types) ? types : [types]);
    const matched = this.events.find((e) => set.has(e.type));
    if (matched) return Promise.resolve(matched);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingResolves.indexOf(handler);
        if (idx >= 0) this.pendingResolves.splice(idx, 1);
        reject(new Error(`timeout waiting for ${[...set].join('|')}`));
      }, timeoutMs);
      const handler = (ev) => {
        if (set.has(ev.type)) {
          clearTimeout(timer);
          resolve(ev);
        } else {
          this.pendingResolves.unshift(handler);
        }
      };
      this.pendingResolves.push(handler);
    });
  }

  async init() {
    this.send({ type: 'init', user_id: this.userId, workspace: '/home/user' });
    return this.waitFor(['ready', 'error']);
  }

  async turn(input, requestId) {
    const id = requestId || `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.send({ type: 'turn', request_id: id, input });
    return this.waitFor(['turn_done', 'error']);
  }

  async shutdown() {
    this.send({ type: 'shutdown' });
    return this.exited;
  }

  kill(signal = 'SIGTERM') {
    try { this.proc.kill(signal); } catch {}
    return this.exited;
  }
}
