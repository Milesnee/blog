// Static config validation. Parses /home/user/openclaw/config.yaml, sanity-
// checks generic fields (paths, sizes, types). Provider/model compatibility
// is checked separately in provider-router so that the validator stays
// decoupled from provider implementations.

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import YAML from 'yaml';

const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const KNOWN_PROVIDERS = new Set(['anthropic', 'deepseek', 'doubao']);
const MAX_SYSTEM_PROMPT_BYTES = 200_000;
const MAX_TOKENS_CAP = 32_000;
const MIN_TOKENS = 64;

export class ConfigError extends Error {
  constructor(field, msg) {
    super(`config.${field}: ${msg}`);
    this.field = field;
    this.kind = 'config';
  }
}

function rejectPathTraversal(field, p) {
  if (typeof p !== 'string') throw new ConfigError(field, 'must be a string');
  if (isAbsolute(p)) throw new ConfigError(field, 'absolute paths forbidden');
  if (p.split(/[/\\]/).some((s) => s === '..')) {
    throw new ConfigError(field, 'path traversal forbidden');
  }
}

export async function loadAndValidate(workspaceRoot) {
  const configPath = resolve(workspaceRoot, 'openclaw/config.yaml');
  let raw;
  try { raw = await readFile(configPath, 'utf8'); }
  catch (e) { throw new ConfigError('config.yaml', `cannot read: ${e.message}`); }

  let parsed;
  try { parsed = YAML.parse(raw); }
  catch (e) { throw new ConfigError('config.yaml', `invalid YAML: ${e.message}`); }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError('config.yaml', 'must be an object at root');
  }
  const agent = parsed.agent;
  if (!agent || typeof agent !== 'object') {
    throw new ConfigError('agent', 'missing or not an object');
  }

  // provider: optional; if set, must be known. Region-policy enforcement
  // happens in provider-router.
  if (agent.provider !== undefined) {
    if (typeof agent.provider !== 'string' || !KNOWN_PROVIDERS.has(agent.provider)) {
      throw new ConfigError('agent.provider', `must be one of ${[...KNOWN_PROVIDERS].join(', ')}`);
    }
  }

  // model: required, string. Whitelist check is the provider's job.
  if (typeof agent.model !== 'string' || !agent.model) {
    throw new ConfigError('agent.model', 'must be a non-empty string');
  }

  // max_tokens: bounded
  const maxTokens = agent.max_tokens ?? 2000;
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_TOKENS || maxTokens > MAX_TOKENS_CAP) {
    throw new ConfigError('agent.max_tokens', `must be int in [${MIN_TOKENS}, ${MAX_TOKENS_CAP}]`);
  }

  // effort: optional; semantic validity (which models support which effort)
  // is the provider's job. We just check it's a known value.
  let effort = agent.effort;
  if (effort !== undefined && effort !== null) {
    if (!ALLOWED_EFFORT.has(effort)) {
      throw new ConfigError('agent.effort', `must be one of ${[...ALLOWED_EFFORT].join(', ')}`);
    }
  } else {
    effort = null;
  }

  // system_prompt: safe path + must exist + size bound
  const promptRel = agent.system_prompt ?? 'prompts/system.md';
  rejectPathTraversal('agent.system_prompt', promptRel);
  const promptPath = resolve(workspaceRoot, 'openclaw', promptRel);
  let systemPrompt;
  try { systemPrompt = await readFile(promptPath, 'utf8'); }
  catch (e) { throw new ConfigError('agent.system_prompt', `cannot read at ${promptPath}: ${e.message}`); }
  if (Buffer.byteLength(systemPrompt, 'utf8') > MAX_SYSTEM_PROMPT_BYTES) {
    throw new ConfigError('agent.system_prompt', `exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
  }

  return {
    provider: agent.provider ?? null, // null = let router decide from region
    model: agent.model,
    maxTokens,
    effort,
    systemPrompt,
    systemPromptPath: promptPath,
  };
}
