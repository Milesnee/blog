// Stateless worker — single-tenant, drives one user's session.
// Receives init/turn/shutdown via NDJSON over stdin, emits ready/turn_chunk/
// turn_done/error via NDJSON on stdout. Logs JSON to stderr.
//
// Lifecycle:
//   spawn → init → ready → 0..N turns → (stdin close OR shutdown OR SIGTERM)
//
// State, config, and user assets live in the bound workspace mount under
// /home/user/. Provider routing is region-gated. Budget is consumer-side
// (dispatcher is the source of truth — see quota.mjs).

import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadAndValidate, ConfigError } from './config-validator.mjs';
import { resolveProvider, ProviderError } from './provider-router.mjs';
import { callStream } from './providers/index.mjs';
import { LocalUserStore } from './user-store.mjs';
import { BudgetTracker, estimateTokens } from './quota.mjs';

const WORKSPACE = process.env.WORKER_WORKSPACE || process.env.HOME || '/home/user';
const USER_ID = process.env.USER_ID || 'anonymous';

let store = null;
let cfg = null;
let resolved = null; // { provider, model, adapterRegion }
let budget = null;
let session = null;  // { messages: [], turn_count, total_input_tokens, total_output_tokens, last_turn_at }
let initialized = false;
let draining = false;
let inFlight = null;

// ---------- IO ----------
function emit(obj) { writeSync(1, JSON.stringify(obj) + '\n'); }
function log(level, msg, extra) {
  writeSync(2, JSON.stringify({
    ts: new Date().toISOString(), level, msg, user: USER_ID, ...extra,
  }) + '\n');
}

// ---------- Session state I/O ----------
const STATE_VERSION = 1;
const STATE_PATH = 'session/current.json';

function emptyState() {
  return {
    version: STATE_VERSION, messages: [], turn_count: 0,
    total_input_tokens: 0, total_output_tokens: 0, last_turn_at: null,
  };
}
async function loadSession() {
  try {
    const raw = await store.read(STATE_PATH);
    const parsed = JSON.parse(raw);
    if (parsed.version !== STATE_VERSION) throw new Error(`state version ${parsed.version}`);
    return parsed;
  } catch (e) {
    if (e.cause?.code === 'ENOENT') return emptyState();
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
}
async function saveSession() {
  await store.writeAtomic(STATE_PATH, JSON.stringify(session));
}

// ---------- Handlers ----------
async function handleInit(req) {
  if (initialized) {
    emit({ type: 'error', error: 'already initialized' });
    return;
  }
  try {
    store = new LocalUserStore(WORKSPACE);
    cfg = await loadAndValidate(WORKSPACE);
    resolved = await resolveProvider({
      region: req.region || 'overseas',
      tier: req.tier || 'free',
      requestedProvider: cfg.provider,
      requestedModel: cfg.model,
    });
    budget = new BudgetTracker(req.budget || {});
    session = await loadSession();
    initialized = true;
    emit({
      type: 'ready',
      provider: resolved.provider,
      model: resolved.model,
      max_tokens: cfg.maxTokens,
      effort: cfg.effort,
      resumed_turns: session.turn_count,
      budget: budget.snapshot(),
    });
    log('info', 'worker ready', {
      provider: resolved.provider, model: resolved.model, resumed: session.turn_count,
    });
  } catch (err) {
    const kind = err.kind || 'init';
    emit({ type: 'error', kind, field: err.field, error: err.message });
    log('error', 'init failed', { kind, err: err.message });
    process.exit(2);
  }
}

async function handleTurn(req) {
  if (!initialized) {
    emit({ type: 'error', request_id: req.request_id, error: 'not initialized' });
    return;
  }
  if (inFlight) {
    emit({ type: 'error', request_id: req.request_id, error: 'turn already in flight' });
    return;
  }

  inFlight = (async () => {
    try {
      // Preflight: refuse if budget clearly insufficient.
      const inputEstimate = estimateTokens(cfg.systemPrompt) + estimateTokens(req.input);
      const outputEstimate = cfg.maxTokens; // worst case
      const pre = budget.preflight(inputEstimate + outputEstimate);
      if (!pre.ok) {
        emit({ type: 'error', request_id: req.request_id, kind: 'budget', error: pre.reason, remaining: pre.remaining });
        return;
      }

      const result = await callStream(resolved.provider, {
        model: resolved.model,
        maxTokens: cfg.maxTokens,
        system: cfg.systemPrompt,
        messages: [...session.messages, { role: 'user', content: req.input }],
        effort: cfg.effort,
        cacheable: true,
      }, (delta) => {
        emit({ type: 'turn_chunk', request_id: req.request_id, delta });
      });

      session.messages.push({ role: 'user', content: req.input });
      session.messages.push({ role: 'assistant', content: result.content });
      session.turn_count += 1;
      session.total_input_tokens += result.usage.input_tokens;
      session.total_output_tokens += result.usage.output_tokens;
      session.last_turn_at = new Date().toISOString();
      budget.consume(result.usage.input_tokens + result.usage.output_tokens);
      await saveSession();

      emit({
        type: 'turn_done',
        request_id: req.request_id,
        stats: {
          provider: resolved.provider,
          model: resolved.model,
          ms: result.ms,
          stop_reason: result.stopReason,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          turn_count: session.turn_count,
          budget: budget.snapshot(),
        },
      });
    } catch (err) {
      emit({
        type: 'error',
        request_id: req.request_id,
        kind: err.kind || 'turn',
        status: err.status,
        error: err.message,
      });
      log('error', 'turn failed', { req: req.request_id, kind: err.kind, err: err.message });
    } finally {
      inFlight = null;
      if (draining) process.exit(0);
    }
  })();
}

async function handleShutdown() {
  draining = true;
  if (inFlight) await inFlight;
  process.exit(0);
}

async function dispatch(line) {
  let req;
  try { req = JSON.parse(line); }
  catch (e) { emit({ type: 'error', error: `invalid JSON: ${e.message}` }); return; }
  switch (req.type) {
    case 'init':     await handleInit(req); break;
    case 'turn':     await handleTurn(req); break;
    case 'shutdown': await handleShutdown(); break;
    default: emit({ type: 'error', error: `unknown type: ${req.type}` });
  }
}

function installSignalHandlers() {
  const onSignal = (sig) => {
    log('info', `received ${sig}, draining`);
    draining = true;
    if (!inFlight) process.exit(0);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

async function main() {
  installSignalHandlers();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (draining) {
      emit({ type: 'error', error: 'worker draining, refusing new requests' });
      continue;
    }
    await dispatch(line);
  }
  log('info', 'stdin closed, exiting');
  if (inFlight) await inFlight;
}

main().catch((err) => {
  log('error', 'fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
