import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPO = resolve(HERE, '..');
const FIXTURE_TEMPLATE = resolve(REPO, 'fixtures/user-template');

export const DATA_DIR = process.env.MILESTONE1_DATA_DIR || '/tmp/milestone-1-data';

export function userDir(userId) {
  return resolve(DATA_DIR, 'users', userId);
}

/** Seed a user workspace from the fixture template. Idempotent. */
export async function seedUser(userId, { reset = true } = {}) {
  const dir = userDir(userId);
  if (reset) {
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });
  await cp(FIXTURE_TEMPLATE, dir, { recursive: true });
  return dir;
}

export async function ensureFixtureExists() {
  try {
    await stat(resolve(FIXTURE_TEMPLATE, 'openclaw/config.yaml'));
  } catch {
    throw new Error(`fixture template missing at ${FIXTURE_TEMPLATE}`);
  }
}
