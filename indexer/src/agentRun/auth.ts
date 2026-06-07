/**
 * Map the unified `AuthSettings` onto pi.dev's runtime Model + AuthStorage.
 *
 * pi separates two concerns:
 *   - which Model<TApi> object to use (model id + base URL + capabilities)
 *   - which credential to inject (AuthStorage — apiKey or OAuth tokens)
 *
 * Three input shapes (post `resolveAuth`):
 *
 *   1. `authType: apiKey` + known `provider:` alias
 *      Standard catalogue lookup via `getModel(piProviderId, modelId)`,
 *      with an in-memory `AuthStorage` carrying the runtime API key.
 *
 *   2. `authType: apiKey` + custom `url:`
 *      Synthesize a `Model<'openai-completions'>` object literal with
 *      `baseUrl` set to the custom URL. AuthStorage gets the API key
 *      keyed under `CUSTOM_PI_PROVIDER_ID`.
 *
 *   3. `authType: openai-oauth`
 *      Use pi-ai's `openai-codex` provider id; AuthStorage is the
 *      *default* file-backed store, so pi-ai reads the OAuth credentials
 *      the user has already logged into via pi's own CLI.
 */

import { getModel, getModels, getProviders, type Model } from '@earendil-works/pi-ai';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import {
  resolveAuth,
  validateAuth,
  CUSTOM_PI_PROVIDER_ID,
  OAUTH_PI_PROVIDER_ID,
  type AuthSettings,
  type ResolvedAuth,
} from '@coffeectx/core';

export interface PiAuth {
  model: Model<any>;
  authStorage: AuthStorage;
  providerId: string;
}

export function buildPiAuth(auth: AuthSettings, path = 'auth'): PiAuth {
  validateAuth(auth, path);
  const resolved = resolveAuth(auth);

  if (resolved.authType === 'openai-oauth') {
    return buildOAuthPath(resolved);
  }
  if (resolved.isCustomUrl) {
    return buildCustomUrlPath(resolved);
  }
  return buildKnownProviderPath(resolved);
}

// ── apiKey + known provider ────────────────────────────────────────────────

function buildKnownProviderPath(resolved: ResolvedAuth): PiAuth {
  const { piProviderId, model: modelId, apiKey } = resolved;
  if (!modelId) {
    throw new Error(`auth.model is required for provider "${piProviderId}".`);
  }

  // getModel is typed via the generated MODELS catalogue but we're passing
  // runtime strings; cast through `any`. It returns `undefined` (NOT throws)
  // when the provider/model pair isn't registered.
  const model = getModel(piProviderId as any, modelId as any) as Model<any> | undefined;
  if (!model) {
    const providers = getProviders();
    if (!providers.includes(piProviderId as never)) {
      throw new Error(
        `Unknown pi-ai provider "${piProviderId}" for known-provider alias. ` +
        `This is a coffeectx misconfiguration — open an issue.`,
      );
    }
    const sampleModels = getModels(piProviderId as any).slice(0, 6).map(m => m.id);
    throw new Error(
      `Unknown model "${modelId}" for provider "${piProviderId}". ` +
      `Sample valid model ids: ${sampleModels.join(', ')}${sampleModels.length === 6 ? ', …' : ''}.`,
    );
  }

  const authStorage = AuthStorage.inMemory();
  if (apiKey) authStorage.setRuntimeApiKey(piProviderId, apiKey);
  return { model, authStorage, providerId: piProviderId };
}

// ── apiKey + custom url ────────────────────────────────────────────────────

function buildCustomUrlPath(resolved: ResolvedAuth): PiAuth {
  const { baseUrl, model: modelId, apiKey } = resolved;
  if (!modelId) {
    throw new Error(`auth.model is required when auth.url is set.`);
  }

  // Synthesize a Model<openai-completions> at runtime. pi-ai's `Model`
  // interface is a plain object literal — `provider` is `KnownProvider |
  // string`, so a sentinel label is fine. Cost / context numbers are
  // placeholders; downstream callers don't actually consult them for the
  // hot path (chat completions). Adjust if a future feature requires real
  // figures.
  const model: Model<'openai-completions'> = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: CUSTOM_PI_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };

  const authStorage = AuthStorage.inMemory();
  if (apiKey) authStorage.setRuntimeApiKey(CUSTOM_PI_PROVIDER_ID, apiKey);
  return { model, authStorage, providerId: CUSTOM_PI_PROVIDER_ID };
}

// ── openai-oauth ───────────────────────────────────────────────────────────

function buildOAuthPath(resolved: ResolvedAuth): PiAuth {
  const providerId = OAUTH_PI_PROVIDER_ID;
  const modelId = resolved.model;

  // For OAuth, pull a default model id from pi-ai's catalogue if the user
  // didn't supply one. The catalogue is the source of truth — picking the
  // first listed model keeps behaviour predictable as pi-ai updates.
  const fallback = modelId ?? getModels(providerId as any)[0]?.id;
  if (!fallback) {
    throw new Error(
      `auth.model required for openai-oauth: no models registered for pi-ai provider "${providerId}".`,
    );
  }
  const model = getModel(providerId as any, fallback as any) as Model<any> | undefined;
  if (!model) {
    throw new Error(
      `openai-oauth: unknown model "${fallback}" for provider "${providerId}". ` +
      `Set a valid model id in auth.model.`,
    );
  }

  // File-backed AuthStorage — pi-ai reads OAuth credentials the user
  // previously logged into via pi's own CLI (stored at ~/.pi/agent/auth.json
  // by default). NO setRuntimeApiKey — OAuth flow handles credential
  // refresh on its own.
  const authStorage = AuthStorage.create();
  return { model, authStorage, providerId };
}
