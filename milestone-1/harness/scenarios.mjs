import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkerPid, startMeasure, summarize } from './measure.mjs';
import { Worker } from './worker-process.mjs';
import { seedUser } from './setup.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPORTS = resolve(HERE, '../reports');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withWorker(userId, mode, fn) {
  const w = new Worker(userId, { mode });
  w.spawn();
  try {
    return await fn(w);
  } finally {
    try { await w.shutdown(); } catch {}
    try { w.kill('SIGKILL'); } catch {}
  }
}

async function runWithMeasure(userId, mode, label, fn) {
  await mkdir(REPORTS, { recursive: true });
  const measureFile = resolve(REPORTS, `${label}-${userId}.pss.tsv`);
  await rm(measureFile, { force: true });
  const w = new Worker(userId, { mode });
  w.spawn();
  // Walk down to the actual node pid; bwrap wrappers have negligible memory.
  const workerPid = await findWorkerPid(w.pid);
  const measure = startMeasure(workerPid, measureFile, { intervalSec: 1 });
  await measure.start();
  let result;
  try {
    result = await fn(w);
  } finally {
    try { await w.shutdown(); } catch {}
    try { w.kill('SIGKILL'); } catch {}
    await measure.stop();
  }
  const samples = await measure.read();
  return { result, samples, mem: summarize(samples) };
}

// ---------- Scenario A: cold start + idle ----------
export async function scenarioA({ mode = 'bwrap' } = {}) {
  const uid = 'scenA';
  await seedUser(uid);
  const { result, mem } = await runWithMeasure(uid, mode, 'A', async (w) => {
    const ready = await w.init();
    if (ready.type !== 'ready') throw new Error(`init failed: ${JSON.stringify(ready)}`);
    await sleep(30_000);
    return { ready };
  });
  return {
    name: 'A: cold start + 30s idle',
    pass: mem.peak_kb !== undefined && mem.peak_kb <= 150_000,
    target: 'PSS <= 150 MB',
    mem,
    result,
  };
}

// ---------- Scenario B: single turn ----------
export async function scenarioB({ mode = 'bwrap', uid = 'scenB' } = {}) {
  await seedUser(uid);
  const { result, mem } = await runWithMeasure(uid, mode, 'B', async (w) => {
    const ready = await w.init();
    if (ready.type !== 'ready') throw new Error(`init failed: ${JSON.stringify(ready)}`);
    const done = await w.turn(
      'In two short paragraphs, explain what a hash table is and when to use one.'
    );
    if (done.type !== 'turn_done') throw new Error(`turn failed: ${JSON.stringify(done)}`);
    // Hold for a few seconds so we capture the post-turn baseline.
    await sleep(5_000);
    return { ready, done };
  });
  return {
    name: 'B: single turn',
    pass: mem.peak_kb !== undefined && mem.peak_kb <= 250_000,
    target: 'peak PSS <= 250 MB',
    mem,
    result,
  };
}

// ---------- Scenario C: long context (20 turns) ----------
export async function scenarioC({ mode = 'bwrap', turns = 20 } = {}) {
  const uid = 'scenC';
  await seedUser(uid);
  const { result, mem, samples } = await runWithMeasure(uid, mode, 'C', async (w) => {
    const ready = await w.init();
    if (ready.type !== 'ready') throw new Error(`init failed: ${JSON.stringify(ready)}`);
    const turnStats = [];
    for (let i = 1; i <= turns; i++) {
      const done = await w.turn(
        `Turn ${i}: continue the story we are building. Add 1-2 sentences only. ` +
          `If this is turn 1, start a story about a small lighthouse.`
      );
      if (done.type !== 'turn_done') throw new Error(`turn ${i} failed: ${JSON.stringify(done)}`);
      turnStats.push(done.stats);
    }
    await sleep(2_000);
    return { ready, turnStats };
  });
  // Pass if growth is bounded (last 5 samples no more than 30MB above first 5)
  const growthBoundedKb = 30_000;
  const linearLeak = mem.growth_kb > growthBoundedKb;
  return {
    name: `C: ${turns} turns`,
    pass: !linearLeak,
    target: `growth <= ${growthBoundedKb / 1000} MB across turns`,
    mem,
    result,
  };
}

// ---------- Scenario D: 6 concurrent workers ----------
export async function scenarioD({ mode = 'bwrap', n = 6 } = {}) {
  await mkdir(REPORTS, { recursive: true });
  const uids = Array.from({ length: n }, (_, i) => `scenD-${i}`);
  for (const uid of uids) await seedUser(uid);

  const workers = uids.map((uid) => new Worker(uid, { mode }));
  for (const w of workers) w.spawn();
  const workerPids = await Promise.all(workers.map((w) => findWorkerPid(w.pid)));
  const measures = workers.map((w, i) => {
    const file = resolve(REPORTS, `D-w${i}.pss.tsv`);
    return { worker: w, m: startMeasure(workerPids[i], file, { intervalSec: 1 }) };
  });
  for (const { m } of measures) await m.start();

  let results;
  try {
    await Promise.all(workers.map(async (w) => {
      const ready = await w.init();
      if (ready.type !== 'ready') throw new Error(`init failed for ${w.userId}`);
    }));
    results = await Promise.all(workers.map(async (w) => {
      return w.turn(
        'In two short paragraphs, explain what a hash table is and when to use one.'
      );
    }));
    await sleep(3_000);
  } finally {
    for (const w of workers) {
      try { await w.shutdown(); } catch {}
      try { w.kill('SIGKILL'); } catch {}
    }
    for (const { m } of measures) await m.stop();
  }

  const perWorker = await Promise.all(measures.map(async ({ m }) => summarize(await m.read())));
  const totalPeakKb = perWorker.reduce((sum, s) => sum + (s.peak_kb || 0), 0);
  return {
    name: `D: ${n} concurrent workers`,
    pass: totalPeakKb <= 3_500_000,
    target: `total peak PSS <= 3500 MB`,
    mem: { per_worker: perWorker, total_peak_kb: totalPeakKb },
    result: { turns: results.map((r) => r.stats || { error: r.error }) },
  };
}

// ---------- Scenario E: kill-recover ----------
export async function scenarioE({ mode = 'bwrap' } = {}) {
  const uid = 'scenE';
  await seedUser(uid);

  const w1 = new Worker(uid, { mode });
  w1.spawn();
  let ready1 = await w1.init();
  if (ready1.type !== 'ready') throw new Error('init1 failed');
  const turnsBefore = 5;
  const t1Stats = [];
  for (let i = 1; i <= turnsBefore; i++) {
    const done = await w1.turn(
      `Turn ${i}: continue our story. Add one short sentence about a lighthouse keeper.`
    );
    if (done.type !== 'turn_done') throw new Error(`pre-kill turn ${i} failed`);
    t1Stats.push(done.stats);
  }
  // Kick off turn 6 but kill before it completes.
  w1.send({
    type: 'turn',
    request_id: 'r-mid',
    input: 'Turn 6: continue the story (this turn will be cut off).',
  });
  await sleep(150);
  w1.kill('SIGKILL');
  await w1.exited;

  // New worker resumes from saved state.
  const w2 = new Worker(uid, { mode });
  w2.spawn();
  const ready2 = await w2.init();
  if (ready2.type !== 'ready') throw new Error('init2 failed');
  const resumedFrom = ready2.resumed_turns;
  const done7 = await w2.turn(
    'Continue the story we were building. Add one sentence that picks up from where we left off.'
  );
  await w2.shutdown();
  if (done7.type !== 'turn_done') throw new Error('post-kill turn failed');

  const ok = resumedFrom === turnsBefore;
  return {
    name: 'E: kill-recover',
    pass: ok,
    target: `worker B resumes from ${turnsBefore} prior turns`,
    mem: { resumed_turns: resumedFrom },
    result: { turns_before: turnsBefore, post_turn_stats: done7.stats },
  };
}

export const SCENARIOS = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE };
