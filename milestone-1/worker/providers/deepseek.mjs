// DeepSeek provider adapter.
// DeepSeek API is OpenAI-compatible: POST /chat/completions with stream=true,
// SSE response, "data: <json>" lines terminated by "data: [DONE]".
// We use native fetch (no SDK dependency) to keep memory footprint small.
//
// DeepSeek prompt caching is automatic on input prefixes ≥ 1024 tokens —
// no opt-in needed. Cached tokens are reported via prompt_cache_hit_tokens
// in the final usage event when stream_options.include_usage is set.

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const NAME = 'deepseek';
export const REGION = 'cn-mainland';
export const ALLOWED_MODELS = new Set([
  'deepseek-chat',      // V3, general
  'deepseek-reasoner',  // R1-style with reasoning
]);

function getKey() {
  const k = process.env.DEEPSEEK_API_KEY;
  if (!k) {
    const e = new Error('DEEPSEEK_API_KEY not set');
    e.kind = 'config';
    throw e;
  }
  return k;
}

// Convert canonical (Anthropic-style) message content to OpenAI string content.
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

export async function callStream(req, onChunk) {
  if (!ALLOWED_MODELS.has(req.model)) {
    throw new Error(`deepseek: model ${req.model} not whitelisted`);
  }

  const messages = [
    { role: 'system', content: req.system },
    ...req.messages.map((m) => ({ role: m.role, content: flattenContent(m.content) })),
  ];

  const start = Date.now();
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const e = new Error(`deepseek ${resp.status}: ${body.slice(0, 500)}`);
    e.kind = 'api_error';
    e.status = resp.status;
    throw e;
  }

  let assistantText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let stopReason = null;

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      const delta = evt.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        assistantText += delta;
        onChunk(delta);
      }
      const fr = evt.choices?.[0]?.finish_reason;
      if (fr) stopReason = fr;
      if (evt.usage) {
        inputTokens = evt.usage.prompt_tokens || 0;
        outputTokens = evt.usage.completion_tokens || 0;
        cachedTokens = evt.usage.prompt_cache_hit_tokens || 0;
      }
    }
  }

  return {
    content: [{ type: 'text', text: assistantText }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cachedTokens,
      cache_creation_input_tokens: 0,
    },
    stopReason: normalizeStop(stopReason),
    ms: Date.now() - start,
  };
}

function normalizeStop(s) {
  // OpenAI/DeepSeek vocabulary → Anthropic-ish vocabulary
  switch (s) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'refusal';
    case 'tool_calls': return 'tool_use';
    default: return s || 'end_turn';
  }
}
