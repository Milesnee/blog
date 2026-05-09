// Anthropic provider adapter.
// Uses the official @anthropic-ai/sdk with streaming + finalMessage().
// Follows claude-api skill guidance: top-level cache_control, typed errors.

import Anthropic from '@anthropic-ai/sdk';

export const NAME = 'anthropic';
export const REGION = 'overseas';
export const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('ANTHROPIC_API_KEY not set');
    e.kind = 'config';
    throw e;
  }
  _client = new Anthropic();
  return _client;
}

const EFFORT_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6',
]);

export async function callStream(req, onChunk) {
  if (!ALLOWED_MODELS.has(req.model)) {
    throw new Error(`anthropic: model ${req.model} not whitelisted`);
  }

  const params = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
  };
  if (req.cacheable !== false) {
    params.cache_control = { type: 'ephemeral' };
  }
  if (req.effort && EFFORT_MODELS.has(req.model)) {
    params.output_config = { effort: req.effort };
  }

  const start = Date.now();
  const stream = client().messages.stream(params);
  stream.on('text', (delta) => onChunk(delta));

  let final;
  try {
    final = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const e = new Error(`anthropic ${err.status}: ${err.message}`);
      e.kind = 'api_error';
      e.status = err.status;
      throw e;
    }
    throw err;
  }

  return {
    content: final.content,
    usage: {
      input_tokens: final.usage.input_tokens || 0,
      output_tokens: final.usage.output_tokens || 0,
      cache_read_input_tokens: final.usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens || 0,
    },
    stopReason: final.stop_reason || 'end_turn',
    ms: Date.now() - start,
  };
}
