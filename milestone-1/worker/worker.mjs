import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadAndValidate, ConfigError } from './config-validator.mjs';
import { loadState, saveState } from './state.mjs';
import { runTurn } from './llm-client.mjs';

const WORKSPACE = process.env.WORKER_WORKSPACE || process.env.HOME || '/home/user';
const USER_ID = process.env.USER_ID || 'anonymous';

let cfg = null;
let state = null;
let initialized = false;
let draining = false;
let inFlight = null;

// Synchronous writes to fd 1/2 — non-blocking pipes can drop buffered writes
// on process.exit(), and we need every event to land before the worker dies.
function emit(obj) {
  writeSync(1, JSON.stringify(obj) + '\n');
}

function log(level, msg, extra) {
  writeSync(
    2,
    JSON.stringify({ ts: new Date().toISOString(), level, msg, user: USER_ID, ...extra }) + '\n'
  );
}

async function handleInit(req) {
  if (initialized) {
    emit({ type: 'error', error: 'already initialized' });
    return;
  }
  try {
    cfg = await loadAndValidate(WORKSPACE);
    state = await loadState(WORKSPACE);
    initialized = true;
    emit({
      type: 'ready',
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      effort: cfg.effort,
      resumed_turns: state.turn_count,
    });
    log('info', 'worker ready', { model: cfg.model, resumed: state.turn_count });
  } catch (err) {
    if (err instanceof ConfigError) {
      emit({ type: 'error', kind: 'config', field: err.field, error: err.message });
    } else {
      emit({ type: 'error', kind: 'init', error: err.message });
    }
    log('error', 'init failed', { err: err.message });
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
      const result = await runTurn(cfg, state.messages, req.input, (delta) => {
        emit({ type: 'turn_chunk', request_id: req.request_id, delta });
      });

      state.messages.push({ role: 'user', content: req.input });
      state.messages.push({ role: 'assistant', content: result.content });
      state.turn_count += 1;
      state.total_input_tokens += result.usage.input_tokens || 0;
      state.total_output_tokens += result.usage.output_tokens || 0;
      state.last_turn_at = new Date().toISOString();

      await saveState(WORKSPACE, state);

      emit({
        type: 'turn_done',
        request_id: req.request_id,
        stats: {
          ms: result.ms,
          stop_reason: result.stopReason,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          turn_count: state.turn_count,
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
      log('error', 'turn failed', { req: req.request_id, err: err.message });
    } finally {
      inFlight = null;
      if (draining) process.exit(0);
    }
  })();
}

async function handleShutdown() {
  draining = true;
  if (inFlight) {
    log('info', 'shutdown: draining in-flight turn');
    await inFlight;
  }
  process.exit(0);
}

async function dispatch(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    emit({ type: 'error', error: `invalid JSON: ${e.message}` });
    return;
  }

  switch (req.type) {
    case 'init':
      await handleInit(req);
      break;
    case 'turn':
      await handleTurn(req);
      break;
    case 'shutdown':
      await handleShutdown();
      break;
    default:
      emit({ type: 'error', error: `unknown type: ${req.type}` });
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

  // for-await drains all queued lines before exiting on stdin close,
  // so we never lose a request to a close-vs-line race.
  log('info', 'stdin closed, exiting');
  if (inFlight) await inFlight;
}

main().catch((err) => {
  log('error', 'fatal', { err: err.message, stack: err.stack });
  process.exit(1);
});
