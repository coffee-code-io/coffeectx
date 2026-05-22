/**
 * Map AuthSettings (from project.jobs[name].parameters.auth) onto the pi SDK's
 * runtime auth + model selection.
 *
 * pi separates two concerns:
 *   - which Model<TApi> object to use, fetched via getModel(provider, modelId)
 *   - which API key to inject, configured on an AuthStorage instance
 *
 * We build an in-memory AuthStorage so the user's per-job credentials never
 * touch the global ~/.pi/agent/auth.json file.
 */

import { getModel, getModels, getProviders, type Model } from '@earendil-works/pi-ai';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import type { AuthSettings } from '@coffeectx/core';

export interface PiAuth {
  model: Model<any>;
  authStorage: AuthStorage;
  providerId: string;
}

/**
 * Build the pi runtime auth pieces from an AuthSettings block.
 *
 * `authType` maps to pi's provider id (e.g. 'openai', 'anthropic',
 * 'openrouter'); `model` is the provider-specific model id; `apiKey` is the
 * raw credential. `baseUrl` is currently ignored — pi resolves base URLs from
 * the provider's built-in config. Users wanting a non-default base should
 * pick a different `authType` (e.g. 'openrouter' rather than 'openai' +
 * OpenRouter URL).
 */
export function buildPiAuth(auth: AuthSettings): PiAuth {
  const providerId = auth.authType ?? 'openai';
  const modelId = auth.model;
  if (!modelId) {
    throw new Error(`auth.model is required (got authType=${providerId})`);
  }

  // getModel is typed via the generated MODELS catalogue but we're passing
  // runtime strings; cast through `any`. It returns `undefined` (NOT throws)
  // when the provider/model pair isn't registered.
  const model = getModel(providerId as any, modelId as any) as Model<any> | undefined;
  if (!model) {
    const providers = getProviders();
    if (!providers.includes(providerId as never)) {
      throw new Error(
        `Unknown LLM provider "${providerId}". ` +
        `Set parameters.auth.authType to one of: ${providers.slice(0, 12).join(', ')}` +
        `${providers.length > 12 ? `, … (${providers.length} total)` : ''}.`,
      );
    }
    const sampleModels = getModels(providerId as any).slice(0, 6).map(m => m.id);
    throw new Error(
      `Unknown model "${modelId}" for provider "${providerId}". ` +
      `Sample valid model ids: ${sampleModels.join(', ')}${sampleModels.length === 6 ? ', …' : ''}. ` +
      `Update parameters.auth.model in your project's job config.`,
    );
  }

  const authStorage = AuthStorage.inMemory();
  if (auth.apiKey) {
    authStorage.setRuntimeApiKey(providerId, auth.apiKey);
  }

  return { model, authStorage, providerId };
}
