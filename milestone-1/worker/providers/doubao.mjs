// Doubao (字节火山引擎方舟) provider adapter.
// Volcengine ARK is OpenAI-compatible: POST /api/v3/chat/completions
// with Bearer token auth and SSE streaming.
//
// Note: Doubao uses *endpoint IDs* (e.g., "ep-2025xxxx-yyyy") as the model
// field, not human-readable names. The whitelist below is a placeholder
// using the documented "model name" form; in production, set DOUBAO_MODEL_<X>
// env vars mapping logical names to endpoint IDs.

const BASE_URL = process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

export const NAME = 'doubao';
export const REGION = 'cn-mainland';
export const ALLOWED_MODELS = new Set([
  'doubao-1-5-pro-32k',
  'doubao-1-5-pro-256k',
  'doubao-1-5-lite-32k',
]);

function getKey() {
  const k = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
  if (!k) {
    const e = new Error('DOUBAO_API_KEY not set');
    e.kind = 'config';
    throw e;
  }
  return k;
}

function resolveModel(logicalName) {
  // Map logical name to endpoint ID via env var if set.
  // Example: DOUBAO_EP_DOUBAO_1_5_PRO_32K=ep-20250101-abcdef
  const envKey = `DOUBAO_EP_${logicalName.replaceAll('-', '_').toUpperCase()}`;
  return process.env[envKey] || logicalName;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  return '';
}

export async function callStream(req, onChunk) {
  if (!ALLOWED_MODELS.has(req.model)) {
    throw new Error(`doubao: model ${req.model} not whitelisted`);
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
      model: resolveModel(req.model),
      messages,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const e = new Error(`doubao ${resp.status}: ${body.slice(0, 500)}`);
    e.kind = 'api_error';
    e.status = resp.status;
    throw e;
  }

  let assistantText = '';
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
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
        // Volcengine reports cached tokens under prompt_tokens_details.cached_tokens
        cachedTokens = evt.usage.prompt_tokens_details?.cached_tokens || 0;
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
    stopReason: stopReason === 'stop' ? 'end_turn' : (stopReason || 'end_turn'),
    ms: Date.now() - start,
  };
}
