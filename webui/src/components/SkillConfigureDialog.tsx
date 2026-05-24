/**
 * Modal that edits a single skill's job config.
 *
 * Fields:
 *   - enabled       — flips `projects.<p>.jobs[<name>].enabled`
 *   - auth          — writes `parameters.auth` (authType / model / apiKey)
 *   - requiredEnv   — one input per var the skill's SKILL.md declared;
 *                     written to `projects.<p>.jobs[<name>].env`
 *
 * Env vars are shown as plain text and pre-populated from the server.
 * Rationale: they're already injected into the agent's prompt verbatim
 * (`runUserJob.ts` Environment preamble), so masking them in the UI
 * would be theater. When a separate secret-material story lands, those
 * inputs will move to a different control with end-to-end opacity.
 *
 * The apiKey input is the lone exception: type="password" and never
 * pre-populated. The server only reports `hasApiKey: true`, not the
 * value. Leaving the field blank on submit preserves the existing key —
 * only a non-empty value overwrites.
 */

import { useState } from 'react';
import type { SkillInfo, SkillConfigurePatch } from '../api/client';

interface Props {
  skill: SkillInfo;
  onClose: () => void;
  onSave: (patch: SkillConfigurePatch) => Promise<void>;
  submitting: boolean;
}

const PROVIDER_PRESETS = [
  { id: 'anthropic',  label: 'Anthropic',  hint: 'e.g. claude-sonnet-4-6' },
  { id: 'openai',     label: 'OpenAI',     hint: 'e.g. gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', hint: 'e.g. anthropic/claude-3.5-sonnet' },
  { id: 'google',     label: 'Google',     hint: 'e.g. gemini-2.0-flash' },
  { id: 'xai',        label: 'xAI',        hint: 'e.g. grok-2-latest' },
];

export function SkillConfigureDialog({ skill, onClose, onSave, submitting }: Props) {
  const [enabled, setEnabled] = useState(skill.enabled);
  const [authType, setAuthType] = useState(skill.auth.authType ?? 'anthropic');
  const [model, setModel] = useState(skill.auth.model ?? '');
  // We never receive the current apiKey from the server (it's secret).
  // Blank input = preserve existing; non-empty = overwrite.
  const [apiKey, setApiKey] = useState('');
  const [env, setEnv] = useState<Record<string, string>>(() => {
    // Pre-fill with the values the server returned (env vars are not
    // treated as secret — the agent sees them verbatim in its prompt, so
    // pretending they're hidden in the UI would just confuse the user).
    // Required vars without a current value still render as empty inputs.
    const initial: Record<string, string> = {};
    for (const k of skill.requiredEnv) initial[k] = skill.env[k] ?? '';
    return initial;
  });

  // Triggers override — stored as raw text so the user can write the
  // four trigger shapes (timer / cron / onNodeState / onTypeInsert) in
  // whatever JSON-array syntax fits. Blank = leave existing config
  // untouched; the literal string `null` clears the override (= reverts
  // to SKILL.md defaults).
  const [triggersText, setTriggersText] = useState(() =>
    skill.triggers ? JSON.stringify(skill.triggers, null, 2) : '');
  const [triggersError, setTriggersError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTriggersError(null);
    const patch: SkillConfigurePatch = { enabled };

    // Only send auth keys the user actually set/edited. authType + model are
    // safe to always send (no secrets); apiKey is only sent when non-empty.
    const auth: SkillConfigurePatch['auth'] = {
      authType: authType || undefined,
      model: model || undefined,
    };
    if (apiKey.trim().length > 0) auth.apiKey = apiKey;
    patch.auth = auth;

    // Env inputs are pre-populated from config and shown as plain text, so
    // what the user sees is what they get: send the current state of every
    // declared var. Blank values mean "unset" — the server's own filter
    // drops empty entries when writing config.yaml. Only send the env
    // patch if the skill declared required vars; otherwise the empty
    // object would clobber any unrelated env block the user has hand-
    // edited in config.
    if (skill.requiredEnv.length > 0) {
      const envOut: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) envOut[k] = v;
      patch.env = envOut;
    }

    // Triggers parsing.
    const trimmed = triggersText.trim();
    if (trimmed === '') {
      // Untouched — don't ship `triggers` at all so the server preserves
      // whatever's there (including any existing override).
    } else if (trimmed === 'null') {
      patch.triggers = null;
    } else {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
        patch.triggers = parsed;
      } catch (err) {
        setTriggersError((err as Error).message);
        return;
      }
    }

    await onSave(patch);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-roast-dark/40 p-4">
      <form
        onSubmit={submit}
        className="bg-cream-50 border border-cream-200 rounded-lg shadow-lg w-full max-w-md max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-cream-200">
          <div className="text-[10px] uppercase tracking-widest text-roast-light">Configure skill</div>
          <div className="font-mono text-roast-dark mt-0.5">{skill.name}</div>
          {skill.description && (
            <div className="text-xs text-roast-medium mt-1">{skill.description}</div>
          )}
        </div>

        <div className="px-4 py-3 space-y-4">
          {/* Enabled */}
          <label className="flex items-center gap-2 text-sm text-roast-dark">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="accent-roast-dark"
            />
            Enabled — scheduler runs this job on its triggers.
          </label>

          {/* Auth */}
          <fieldset className="space-y-2">
            <legend className="text-[11px] uppercase tracking-widest text-roast-light">Auth</legend>
            <Field label="Provider">
              <select
                value={authType}
                onChange={e => setAuthType(e.target.value)}
                className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark"
              >
                {PROVIDER_PRESETS.map(p => (
                  <option key={p.id} value={p.id}>{p.label} ({p.id})</option>
                ))}
                {/* Custom provider — surfaces ids returned by pi that aren't
                    in the preset list (e.g. user installed an extra). */}
                {!PROVIDER_PRESETS.some(p => p.id === authType) && (
                  <option value={authType}>{authType} (custom)</option>
                )}
              </select>
            </Field>
            <Field label="Model">
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder={PROVIDER_PRESETS.find(p => p.id === authType)?.hint ?? 'model id'}
                className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light font-mono"
              />
            </Field>
            <Field
              label="API key"
              hint={skill.auth.hasApiKey ? 'Existing key kept if left blank.' : undefined}
            >
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={skill.auth.hasApiKey ? '••••••••' : 'sk-…'}
                autoComplete="off"
                className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light font-mono"
              />
            </Field>
          </fieldset>

          {/* Required env */}
          {skill.requiredEnv.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-[11px] uppercase tracking-widest text-roast-light">
                Env vars
                <span className="ml-1 normal-case tracking-normal text-roast-light/70">
                  (existing values kept if blank; shown to the agent verbatim — not secret)
                </span>
              </legend>
              {skill.requiredEnv.map(key => {
                const isSet = skill.configuredEnvKeys.includes(key);
                return (
                  <Field
                    key={key}
                    label={key}
                    hint={isSet ? 'Currently set in config.' : 'Not set.'}
                  >
                    <input
                      type="text"
                      value={env[key] ?? ''}
                      onChange={e => setEnv(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={isSet ? '(leave blank to keep existing)' : ''}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light font-mono"
                    />
                  </Field>
                );
              })}
            </fieldset>
          )}

          {/* Triggers override */}
          <fieldset className="space-y-2">
            <legend className="text-[11px] uppercase tracking-widest text-roast-light">
              Triggers
              <span className="ml-1 normal-case tracking-normal text-roast-light/70">
                (overrides SKILL.md default)
              </span>
            </legend>
            <Field
              label="JSON array of triggers"
              hint={
                'Blank = leave existing config; `null` = clear the override; otherwise a JSON ' +
                'array like [{"kind":"cron","expression":"0 9 * * *"}].'
              }
            >
              <textarea
                value={triggersText}
                onChange={e => { setTriggersText(e.target.value); setTriggersError(null); }}
                placeholder={skill.triggers ? '' : '[\n  {"kind": "cron", "expression": "0 9 * * *"}\n]'}
                rows={5}
                className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-xs text-roast-dark placeholder:text-roast-light font-mono"
              />
            </Field>
            {triggersError && (
              <div className="text-[11px] text-status-error">triggers parse error: {triggersError}</div>
            )}
          </fieldset>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-cream-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-roast-medium hover:text-roast-dark disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-roast-dark text-cream-50 rounded hover:bg-roast-medium disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] text-roast-medium font-mono mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-roast-light mt-0.5">{hint}</div>}
    </label>
  );
}
