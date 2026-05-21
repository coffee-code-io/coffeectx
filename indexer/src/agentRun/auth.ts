import type { QueryOptions } from '@qwen-code/sdk';
import type { AuthSettings } from '@coffeectx/core';

/** Re-export for callers that previously imported the local AuthConfig. */
export type AuthConfig = AuthSettings;

/**
 * Convert an AuthSettings to a partial QueryOptions object suitable for
 * merging into the options passed to query().
 */
export function authToQueryOptions(auth: AuthSettings): Partial<QueryOptions> {
  const env: Record<string, string> = {};
  if (auth.apiKey) env['OPENAI_API_KEY'] = auth.apiKey;
  if (auth.baseUrl) env['OPENAI_BASE_URL'] = auth.baseUrl;

  return {
    ...(auth.authType ? { authType: auth.authType } : {}),
    ...(auth.model ? { model: auth.model } : {}),
    ...(auth.qwenPath ? { pathToQwenExecutable: auth.qwenPath } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
