/**
 * Unified LLM auth schema.
 *
 * One `AuthSettings` shape is used by every credential block in
 * `~/.coffeecode/config.yaml`:
 *
 *   - `projects.<name>.core.embed.auth`              — embedding model
 *   - `projects.<name>.agent.auth`                    — UI chat agent
 *   - `projects.<name>.jobs.<job>.parameters.auth`    — every job agent
 *
 * Two modes:
 *
 *   1. `authType: openai-oauth`
 *      OpenAI Codex OAuth flow handled by pi.dev. No other fields needed
 *      (the runtime reads credentials from the global pi auth store).
 *
 *   2. `authType: apiKey`
 *      Conventional API-key auth. Pick a known endpoint via `provider:` from
 *      the static alias list, OR set a fully custom `url:` (treated as
 *      OpenAI-compatible). Always carries `model` + `apiKey`.
 */

// ── Public types ──────────────────────────────────────────────────────────

export type AuthMode = 'apiKey' | 'openai-oauth';

/**
 * Static list of known LLM endpoints. Each maps to a fixed base URL — the
 * "alias" form of auth. New entries here are the only thing needed to add
 * a known provider (no code path changes elsewhere).
 */
export type AuthProviderAlias = 'openai' | 'anthropic' | 'openrouter';

export interface AuthSettings {
  authType: AuthMode;
  /** `apiKey` mode: choose ONE of `provider` (alias) or `url` (custom). */
  provider?: AuthProviderAlias;
  url?: string;
  /** Required in `apiKey` mode; optional in `openai-oauth` mode (pi-ai default). */
  model?: string;
  /** Required in `apiKey` mode; absent in `openai-oauth` mode. */
  apiKey?: string;
}

/** Resolved shape every consumer (embed / pi runner) reads — no further
 *  branching needed downstream. */
export interface ResolvedAuth {
  authType: AuthMode;
  /** Resolved endpoint URL (from `provider` alias or `url`). */
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Identifier used to key pi.dev's runtime auth store + catalogue lookup.
   *  For known providers: the pi-ai provider id. For custom-url: `'custom'`.
   *  For OAuth: pi-ai's OAuth provider id (`openai-codex` today). */
  piProviderId: string;
  /** True iff the user supplied a custom `url:` instead of a `provider:` alias. */
  isCustomUrl: boolean;
}

// ── Lookup tables (single source of truth) ─────────────────────────────────

export const STATIC_PROVIDER_URL: Record<AuthProviderAlias, string> = {
  openai:     'https://api.openai.com/v1',
  anthropic:  'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Maps our alias → the pi-ai catalogue's KnownProvider id. 1:1 today; the
 *  indirection lets us alias a different label later (e.g. `gemini` →
 *  pi-ai's `google`) without touching call sites. */
export const PROVIDER_TO_PI_ID: Record<AuthProviderAlias, string> = {
  openai:     'openai',
  anthropic:  'anthropic',
  openrouter: 'openrouter',
};

/** pi-ai's OAuth provider id for OpenAI Codex (what we expose as `openai-oauth`). */
export const OAUTH_PI_PROVIDER_ID = 'openai-codex';

/** Synthetic provider id used when the user supplies a custom `url:`. Lives in
 *  pi-ai's auth store keyed by this label; doesn't need to exist in the
 *  catalogue because we build the Model object by hand. */
export const CUSTOM_PI_PROVIDER_ID = 'custom';

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Throw with a path-tagged message when `auth` doesn't match the schema.
 * `path` is the YAML path being validated, e.g. `"projects.foo.agent.auth"`,
 * woven into the error so the user knows which block to fix.
 */
export function validateAuth(auth: unknown, path: string): asserts auth is AuthSettings {
  if (!auth || typeof auth !== 'object') {
    throw new Error(`${path}: expected an object (got ${describe(auth)})`);
  }
  const a = auth as Record<string, unknown>;

  if (a['authType'] !== 'apiKey' && a['authType'] !== 'openai-oauth') {
    throw new Error(
      `${path}.authType: must be one of "apiKey" | "openai-oauth" (got ${describe(a['authType'])}). ` +
      `See indexer/README.md for the auth schema.`,
    );
  }

  if (a['authType'] === 'openai-oauth') {
    // `model` is optional in OAuth mode (pi-ai picks a default for the
    // codex provider). All other fields are noise — but accept them silently
    // so a user flipping authType doesn't have to scrub the file.
    return;
  }

  // authType === 'apiKey' from here.
  const hasProvider = typeof a['provider'] === 'string' && (a['provider'] as string).length > 0;
  const hasUrl = typeof a['url'] === 'string' && (a['url'] as string).length > 0;
  if (hasProvider && hasUrl) {
    throw new Error(
      `${path}: set exactly one of provider or url (both supplied). ` +
      `provider is the alias for a known endpoint; url is a custom OpenAI-compatible URL.`,
    );
  }
  if (!hasProvider && !hasUrl) {
    throw new Error(
      `${path}: must set provider (one of ${Object.keys(STATIC_PROVIDER_URL).join(' | ')}) or url.`,
    );
  }
  if (hasProvider && !(a['provider'] as string in STATIC_PROVIDER_URL)) {
    throw new Error(
      `${path}.provider: must be one of ${Object.keys(STATIC_PROVIDER_URL).join(' | ')} ` +
      `(got "${String(a['provider'])}").`,
    );
  }
  if (typeof a['model'] !== 'string' || !(a['model'] as string).length) {
    throw new Error(`${path}.model: required when authType is "apiKey".`);
  }
  if (typeof a['apiKey'] !== 'string' || !(a['apiKey'] as string).length) {
    throw new Error(`${path}.apiKey: required when authType is "apiKey".`);
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve an `AuthSettings` block into the downstream-ready `ResolvedAuth`.
 * Assumes the input already passed `validateAuth` — callers without that
 * guarantee should validate first.
 */
export function resolveAuth(auth: AuthSettings): ResolvedAuth {
  if (auth.authType === 'openai-oauth') {
    return {
      authType: 'openai-oauth',
      // OAuth flow doesn't actually need a base URL surfaced — pi-ai resolves
      // it via the openai-codex provider config. We still populate the field
      // for symmetry / debugging.
      baseUrl: 'https://api.openai.com/v1',
      model: auth.model,
      piProviderId: OAUTH_PI_PROVIDER_ID,
      isCustomUrl: false,
    };
  }

  // apiKey mode.
  if (auth.url) {
    return {
      authType: 'apiKey',
      baseUrl: auth.url,
      apiKey: auth.apiKey,
      model: auth.model,
      piProviderId: CUSTOM_PI_PROVIDER_ID,
      isCustomUrl: true,
    };
  }
  const alias = auth.provider!;   // post-validation invariant
  return {
    authType: 'apiKey',
    baseUrl: STATIC_PROVIDER_URL[alias],
    apiKey: auth.apiKey,
    model: auth.model,
    piProviderId: PROVIDER_TO_PI_ID[alias],
    isCustomUrl: false,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return `"${v}"`;
  return typeof v;
}
