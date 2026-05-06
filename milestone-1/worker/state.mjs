import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    messages: [],
    turn_count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    last_turn_at: null,
  };
}

export async function loadState(workspaceRoot) {
  const path = resolve(workspaceRoot, 'session/current.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== STATE_VERSION) {
      throw new Error(`state version ${parsed.version} != ${STATE_VERSION}`);
    }
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
}

export async function saveState(workspaceRoot, state) {
  const path = resolve(workspaceRoot, 'session/current.json');
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, path);
}
