import Anthropic from '@anthropic-ai/sdk';

let _client = null;

export function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Run one turn against Anthropic Messages API with streaming.
 *
 * @param {object} cfg validated config (model, maxTokens, systemPrompt, effort)
 * @param {Array} priorMessages prior MessageParam[] from session state
 * @param {string} userInput user text for this turn
 * @param {(delta: string) => void} onChunk called for each text delta
 * @returns {Promise<{content: any[], usage: object, ms: number}>}
 */
export async function runTurn(cfg, priorMessages, userInput, onChunk) {
  const client = getClient();
  const messages = [...priorMessages, { role: 'user', content: userInput }];

  const params = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: cfg.systemPrompt,
    cache_control: { type: 'ephemeral' },
    messages,
  };
  if (cfg.effort) {
    params.output_config = { effort: cfg.effort };
  }

  const start = Date.now();
  const stream = client.messages.stream(params);
  stream.on('text', (delta) => onChunk(delta));

  let finalMessage;
  try {
    finalMessage = await stream.finalMessage();
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
    content: finalMessage.content,
    usage: finalMessage.usage,
    stopReason: finalMessage.stop_reason,
    ms: Date.now() - start,
  };
}
