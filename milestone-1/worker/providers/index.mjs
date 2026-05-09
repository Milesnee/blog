// Provider registry with lazy loading.
// We only import the SDK / adapter for the provider actually used,
// keeping idle worker memory minimal (Anthropic SDK alone is ~5MB).

const LOADERS = {
  anthropic: () => import('./anthropic.mjs'),
  deepseek: () => import('./deepseek.mjs'),
  doubao: () => import('./doubao.mjs'),
};

const _cache = new Map();

export const KNOWN_PROVIDERS = Object.keys(LOADERS);

export async function load(name) {
  if (!LOADERS[name]) throw new Error(`unknown provider: ${name}`);
  if (!_cache.has(name)) _cache.set(name, LOADERS[name]());
  return _cache.get(name);
}

export async function callStream(name, req, onChunk) {
  const provider = await load(name);
  return provider.callStream(req, onChunk);
}

export async function getMeta(name) {
  const p = await load(name);
  return { name: p.NAME, region: p.REGION, models: [...p.ALLOWED_MODELS] };
}
