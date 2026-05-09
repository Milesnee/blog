// User storage abstraction.
// Day 1: simple wrapper over local FS rooted at the bwrap-mounted workspace.
// The interface is intentionally minimal so it can be replaced in M3+
// (sharded local) and M5 (sharded local + S3 cache) without changing the
// worker code.

import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

export class StoreError extends Error {
  constructor(op, relPath, cause) {
    super(`user-store.${op}(${relPath}): ${cause.message}`);
    this.op = op;
    this.relPath = relPath;
    this.cause = cause;
  }
}

function safeJoin(base, rel) {
  if (isAbsolute(rel)) throw new Error(`absolute path forbidden: ${rel}`);
  if (rel.split(/[/\\]/).some((s) => s === '..')) {
    throw new Error(`path traversal forbidden: ${rel}`);
  }
  return resolve(base, rel);
}

export class LocalUserStore {
  constructor(rootPath) {
    this.root = rootPath;
  }

  async read(relPath) {
    try {
      return await readFile(safeJoin(this.root, relPath), 'utf8');
    } catch (e) { throw new StoreError('read', relPath, e); }
  }

  async readBuffer(relPath) {
    try {
      return await readFile(safeJoin(this.root, relPath));
    } catch (e) { throw new StoreError('readBuffer', relPath, e); }
  }

  async writeAtomic(relPath, content) {
    const full = safeJoin(this.root, relPath);
    try {
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.tmp.${process.pid}`;
      await writeFile(tmp, content);
      await rename(tmp, full);
    } catch (e) { throw new StoreError('writeAtomic', relPath, e); }
  }

  async exists(relPath) {
    try {
      await stat(safeJoin(this.root, relPath));
      return true;
    } catch { return false; }
  }

  async list(relPrefix) {
    try {
      return await readdir(safeJoin(this.root, relPrefix));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new StoreError('list', relPrefix, e);
    }
  }
}
