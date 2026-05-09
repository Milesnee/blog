// Provider routing — given (user region, tier, requested provider/model),
// decide what actually gets called.
//
// Compliance invariant (do not weaken): cn-mainland users MUST use a
// cn-mainland provider. Per PIPL §38, dialogue content cannot leave the
// country without separate cross-border data transfer assessment.
//
// Failure mode: if config requests an out-of-region provider, we DO NOT
// silently redirect. We throw a config error so init fails loudly. This
// surfaces misconfigurations rather than masking them.

import { load, KNOWN_PROVIDERS } from './providers/index.mjs';

const CN_PROVIDERS = new Set(['deepseek', 'doubao']);
const OVERSEAS_PROVIDERS = new Set(['anthropic']);

const DEFAULTS = {
  'cn-mainland': { provider: 'deepseek', model: 'deepseek-chat' },
  overseas: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

export function defaultsFor(region) {
  return DEFAULTS[region] || DEFAULTS.overseas;
}

export class ProviderError extends Error {
  constructor(field, msg) {
    super(`provider-router.${field}: ${msg}`);
    this.field = field;
    this.kind = 'provider-policy';
  }
}

export async function resolveProvider({ region, tier, requestedProvider, requestedModel }) {
  const allowedSet = region === 'cn-mainland' ? CN_PROVIDERS : OVERSEAS_PROVIDERS;
  const provider = requestedProvider || DEFAULTS[region]?.provider || DEFAULTS.overseas.provider;

  if (!KNOWN_PROVIDERS.includes(provider)) {
    throw new ProviderError('provider', `unknown provider: ${provider}`);
  }
  if (!allowedSet.has(provider)) {
    throw new ProviderError(
      'provider',
      `provider "${provider}" not allowed for region "${region}". ` +
        `Allowed: ${[...allowedSet].join(', ')}`
    );
  }

  const adapter = await load(provider);
  const model = requestedModel || DEFAULTS[region]?.model || DEFAULTS.overseas.model;
  if (!adapter.ALLOWED_MODELS.has(model)) {
    throw new ProviderError(
      'model',
      `model "${model}" not whitelisted for provider "${provider}". ` +
        `Allowed: ${[...adapter.ALLOWED_MODELS].join(', ')}`
    );
  }

  // Tier policy hooks (placeholder for now — Sprint 3 fills in).
  // Free users get cheapest model, paid users get any whitelisted.
  return { provider, model, adapterRegion: adapter.REGION };
}
