/**
 * Provider Adapter contract — every LLM backend conforms to this.
 *
 * Each provider module exports:
 *
 *   export const NAME: string                  // 'anthropic' | 'deepseek' | 'doubao'
 *   export const REGION: 'cn-mainland' | 'overseas'
 *   export const ALLOWED_MODELS: Set<string>   // whitelist of model ids this provider serves
 *   export async function callStream(req, onChunk): Promise<TurnResult>
 *
 * Request shape (provider-agnostic, Anthropic-style canonical):
 *   req = {
 *     model:      string,      // model id (must be in ALLOWED_MODELS)
 *     maxTokens:  number,
 *     system:     string,      // system prompt text
 *     messages:   Array<{role, content}>,
 *                              // role: 'user' | 'assistant'
 *                              // content: string OR Array<{type:'text', text}>
 *     effort?:    'low'|'medium'|'high'|'xhigh'|'max',  // optional
 *     cacheable?: boolean,     // hint: provider may cache the system prompt prefix
 *   }
 *
 * Response shape (normalized):
 *   {
 *     content:   Array<{type:'text', text}>,
 *     usage: {
 *       input_tokens:               number,
 *       output_tokens:              number,
 *       cache_read_input_tokens:    number,  // 0 if provider doesn't expose
 *       cache_creation_input_tokens: number, // 0 if provider doesn't expose
 *     },
 *     stopReason: 'end_turn'|'max_tokens'|'stop'|'tool_use'|'refusal'|'error'|string,
 *     ms:        number,
 *   }
 *
 * Error contract:
 *   On API error, throw an Error with .kind = 'api_error' and .status = HTTP code.
 *   On config error (missing key, etc), throw with .kind = 'config'.
 */
export const PROVIDER_CONTRACT_VERSION = 1;
