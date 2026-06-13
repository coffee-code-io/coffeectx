/**
 * `coffeectx login <provider>` — interactive OAuth login that drives pi.dev's
 * registered OAuth provider flow and persists credentials under the pi auth
 * store (`$COFFEECODE_DIR/.pi/agent/auth.json` by default, see
 * `packages/core/src/config.ts`'s `PI_AGENT_DIR`).
 *
 * Login is intentionally decoupled from `~/.coffeecode/config.yaml`. After
 * a successful login the user separately opts a bucket into OAuth by setting
 * `authType: openai-oauth` (or another OAuth flavor) in the corresponding
 * `auth:` block. This way one user can run `embed` with `apiKey` and
 * `indexer` with `openai-oauth` against the same set of stored credentials.
 *
 * Today only `openai-oauth → openai-codex` is wired. The `LOGIN_PROVIDERS`
 * map is the single extension point — adding `anthropic-oauth → anthropic`
 * etc. is a one-row change.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import { OAUTH_PI_PROVIDER_ID, PI_AGENT_DIR } from '@coffeectx/core';

/** Alias surfaced to the user → pi-ai's registered OAuth provider id. */
const LOGIN_PROVIDERS: Record<string, string> = {
  'openai-oauth': OAUTH_PI_PROVIDER_ID, // 'openai-codex'
};

export async function runLogin(providerLabel: string): Promise<void> {
  const piProviderId = LOGIN_PROVIDERS[providerLabel];
  if (!piProviderId) {
    throw new Error(
      `Unknown login provider "${providerLabel}". ` +
      `Supported: ${Object.keys(LOGIN_PROVIDERS).join(', ')}.`,
    );
  }

  // File-backed storage — defaults to pi's `getAuthPath()` which honours
  // the `PI_CODING_AGENT_DIR` env var coffeectx sets at core/config load.
  const storage = AuthStorage.create();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ac = new AbortController();

  // Ctrl-C → cancel the OAuth flow cleanly (pi-ai propagates the abort to
  // its loopback HTTP server). The readline cleanup happens in the finally
  // block so the prompt doesn't hang the terminal on cancel.
  const onSigInt = () => { ac.abort(); rl.close(); };
  process.once('SIGINT', onSigInt);

  try {
    await storage.login(piProviderId, {
      onAuth: ({ url, instructions }) => {
        console.log(`\nOpen this URL in a browser to complete login:\n  ${url}`);
        if (instructions) console.log(instructions);
        openInBrowser(url);
      },
      onDeviceCode: ({ userCode, verificationUri }) => {
        console.log(`\nDevice code: ${userCode}`);
        console.log(`Enter it at: ${verificationUri}`);
      },
      onPrompt: prompt => askPrompt(rl, prompt.message),
      onSelect: async ({ message, options }) => {
        console.log(`\n${message}`);
        options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
        const answer = await askPrompt(rl, `Select [1-${options.length}]`);
        const idx = Number(answer) - 1;
        return options[idx]?.id;
      },
      onProgress: msg => console.log(msg),
      signal: ac.signal,
    });
    console.log(
      `\nLogged into "${providerLabel}" — credentials persisted under ${PI_AGENT_DIR}.`,
    );
  } finally {
    process.removeListener('SIGINT', onSigInt);
    rl.close();
  }
}

function askPrompt(rl: ReturnType<typeof createInterface>, message: string): Promise<string> {
  return new Promise(resolve => rl.question(`${message}: `, ans => resolve(ans.trim())));
}

function openInBrowser(url: string): void {
  // Best-effort — if the platform-specific launcher fails the user can
  // still paste the URL by hand from the console output above.
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // ignore — user has the URL in stdout
  }
}
