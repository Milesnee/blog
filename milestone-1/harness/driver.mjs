import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixtureExists } from './setup.mjs';
import { SCENARIOS } from './scenarios.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPORTS = resolve(HERE, '../reports');
const MODE = process.env.MODE || 'bwrap';

function fmtKb(kb) {
  if (kb === undefined || kb === null) return 'n/a';
  return `${(kb / 1024).toFixed(1)} MB`;
}

function printResult(r) {
  const status = r.pass ? 'PASS' : 'FAIL';
  console.log(`\n[${status}] ${r.name}`);
  console.log(`       target: ${r.target}`);
  if (r.mem.peak_kb !== undefined) {
    console.log(`       peak PSS: ${fmtKb(r.mem.peak_kb)}, ` +
      `last: ${fmtKb(r.mem.last_kb)}, growth: ${fmtKb(r.mem.growth_kb)} ` +
      `(${r.mem.count} samples over ${r.mem.duration_s?.toFixed(1)}s)`);
  } else if (r.mem.total_peak_kb !== undefined) {
    console.log(`       total peak PSS: ${fmtKb(r.mem.total_peak_kb)}`);
    r.mem.per_worker.forEach((m, i) => {
      console.log(`         w${i}: peak ${fmtKb(m.peak_kb)}, last ${fmtKb(m.last_kb)}`);
    });
  } else {
    console.log(`       result: ${JSON.stringify(r.mem)}`);
  }
}

async function main() {
  await ensureFixtureExists();
  await mkdir(REPORTS, { recursive: true });

  const argv = process.argv.slice(2);
  let toRun;
  if (argv.length === 0 || argv[0] === 'all') {
    toRun = ['A', 'B', 'C', 'D', 'E'];
  } else {
    toRun = argv.map((s) => s.toUpperCase());
  }

  const unknown = toRun.filter((k) => !SCENARIOS[k]);
  if (unknown.length) {
    console.error(`unknown scenarios: ${unknown.join(', ')}`);
    process.exit(2);
  }

  console.log(`mode: ${MODE}`);
  console.log(`scenarios: ${toRun.join(', ')}\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set; scenarios B/C/D/E will fail.');
  }

  const results = [];
  for (const k of toRun) {
    console.log(`---- running scenario ${k} ----`);
    const t0 = Date.now();
    try {
      const r = await SCENARIOS[k]({ mode: MODE });
      r.duration_ms = Date.now() - t0;
      results.push(r);
      printResult(r);
    } catch (e) {
      const err = { name: `${k}: errored`, pass: false, target: 'completes', mem: {}, error: e.message };
      results.push(err);
      console.error(`\n[ERROR] scenario ${k} threw: ${e.message}`);
      console.error(e.stack);
    }
  }

  const reportPath = resolve(REPORTS, `report-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify({
    mode: MODE,
    timestamp: new Date().toISOString(),
    results,
  }, null, 2));
  console.log(`\nwrote ${reportPath}`);

  const fails = results.filter((r) => !r.pass).length;
  console.log(`\nsummary: ${results.length - fails}/${results.length} passed`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('driver fatal:', e);
  process.exit(1);
});
