import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import YAML from 'yaml';

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const MAX_SYSTEM_PROMPT_BYTES = 200_000;
const MAX_TOKENS_CAP = 32_000;
const MIN_TOKENS = 64;

class ConfigError extends Error {
  constructor(field, msg) {
    super(`config.${field}: ${msg}`);
    this.field = field;
  }
}

function rejectPathTraversal(field, p) {
  if (typeof p !== 'string') throw new ConfigError(field, 'must be a string');
  if (isAbsolute(p)) throw new ConfigError(field, 'absolute paths forbidden');
  if (p.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new ConfigError(field, 'path traversal forbidden');
  }
}

export async function loadAndValidate(workspaceRoot) {
  const configPath = resolve(workspaceRoot, 'openclaw/config.yaml');
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError('config.yaml', `cannot read at ${configPath}: ${e.message}`);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new ConfigError('config.yaml', `invalid YAML: ${e.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError('config.yaml', 'must be an object at root');
  }

  const agent = parsed.agent;
  if (!agent || typeof agent !== 'object') {
    throw new ConfigError('agent', 'missing or not an object');
  }

  if (!ALLOWED_MODELS.has(agent.model)) {
    throw new ConfigError('agent.model', `not in whitelist: ${[...ALLOWED_MODELS].join(', ')}`);
  }

  const maxTokens = agent.max_tokens ?? 8_000;
  if (!Number.isInteger(maxTokens) || maxTokens < MIN_TOKENS || maxTokens > MAX_TOKENS_CAP) {
    throw new ConfigError('agent.max_tokens', `must be int in [${MIN_TOKENS}, ${MAX_TOKENS_CAP}]`);
  }

  let effort = agent.effort;
  if (effort !== undefined && effort !== null) {
    if (!ALLOWED_EFFORT.has(effort)) {
      throw new ConfigError('agent.effort', `must be one of ${[...ALLOWED_EFFORT].join(', ')}`);
    }
    // Effort param only on Opus 4.5+ and Sonnet 4.6 (per Anthropic docs).
    const supportsEffort = agent.model.startsWith('claude-opus-') || agent.model === 'claude-sonnet-4-6';
    if (!supportsEffort) {
      throw new ConfigError('agent.effort', `not supported on model ${agent.model}; remove effort or change model`);
    }
    if (effort === 'max' && !agent.model.startsWith('claude-opus-')) {
      throw new ConfigError('agent.effort', '"max" only supported on Opus-tier models');
    }
  } else {
    effort = null;
  }

  rejectPathTraversal('agent.system_prompt', agent.system_prompt ?? 'prompts/system.md');
  const promptRel = agent.system_prompt ?? 'prompts/system.md';
  const promptPath = resolve(workspaceRoot, 'openclaw', promptRel);
  let systemPrompt;
  try {
    systemPrompt = await readFile(promptPath, 'utf8');
  } catch (e) {
    throw new ConfigError('agent.system_prompt', `cannot read at ${promptPath}: ${e.message}`);
  }
  if (Buffer.byteLength(systemPrompt, 'utf8') > MAX_SYSTEM_PROMPT_BYTES) {
    throw new ConfigError('agent.system_prompt', `exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
  }

  return {
    model: agent.model,
    maxTokens,
    effort: effort ?? null,
    systemPrompt,
    systemPromptPath: promptPath,
  };
}

export { ConfigError };
