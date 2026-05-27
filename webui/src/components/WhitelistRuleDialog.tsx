/**
 * Modal to create or edit a single whitelist rule in
 * `~/.coffeecode/secrets.yaml`. The rule controls which bash command the
 * `exec_elevated` tool may run, which files must hash-match before it runs,
 * which env vars may pass through, and which configured secrets may be
 * injected.
 *
 * File hashes are not entered by hand: the user types a path; the dialog
 * calls `api.hashFile` to validate existence and preview the sha256.
 * On save the server recomputes hashes authoritatively, so the preview is
 * only a UX aid — divergent hashes between preview and save are accepted
 * (the file may have legitimately changed in between).
 */

import { useState } from 'react';
import { api, type WhitelistRuleView, type WhitelistRuleInput } from '../api/client';

interface Props {
  /** Existing rule to edit, or null for a new rule. */
  initial: WhitelistRuleView | null;
  /** Names of configured secrets in this project (chips to pick from). */
  availableSecrets: string[];
  /** Coffeectx project name (passed to `api.hashFile`). */
  project: string;
  onClose: () => void;
  onSave: (body: WhitelistRuleInput) => Promise<void>;
  submitting: boolean;
}

interface FileDraft {
  path: string;
  exists?: boolean;
  hash?: string;
  checking?: boolean;
  error?: string;
}

export function WhitelistRuleDialog({
  initial, availableSecrets, project, onClose, onSave, submitting,
}: Props) {
  const [command, setCommand] = useState(initial?.command ?? '');
  const [files, setFiles] = useState<FileDraft[]>(() =>
    (initial?.files ?? []).map(f => ({
      path: f.path,
      exists: f.exists,
      hash: f.currentHash ?? f.hash,
    })),
  );
  const [allowedEnv, setAllowedEnv] = useState<string[]>(initial?.allowed_env ?? []);
  const [secrets, setSecrets] = useState<string[]>(initial?.secrets ?? []);
  const [error, setError] = useState<string | null>(null);

  const updateFile = (i: number, patch: Partial<FileDraft>) =>
    setFiles(prev => prev.map((f, idx) => idx === i ? { ...f, ...patch } : f));

  const checkFile = async (i: number) => {
    const f = files[i];
    if (!f || f.path.trim().length === 0) return;
    updateFile(i, { checking: true, error: undefined });
    try {
      const res = await api.hashFile(project, f.path);
      updateFile(i, { checking: false, exists: res.exists, hash: res.hash });
    } catch (err) {
      updateFile(i, { checking: false, error: (err as Error).message });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (command.trim().length === 0) {
      setError('command is required');
      return;
    }
    const cleanFiles = files
      .map(f => ({ path: f.path.trim() }))
      .filter(f => f.path.length > 0);
    if (cleanFiles.some((_, i) => files[i] && files[i]!.exists === false)) {
      setError('one or more files do not exist on disk');
      return;
    }
    try {
      await onSave({
        command: command.trim(),
        files: cleanFiles,
        allowed_env: allowedEnv.map(s => s.trim()).filter(s => s.length > 0),
        secrets,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-roast-dark/40 p-4">
      <form
        onSubmit={submit}
        className="bg-cream-50 border border-cream-200 rounded-lg shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="px-4 py-3 border-b border-cream-200">
          <div className="text-[10px] uppercase tracking-widest text-roast-light">
            {initial ? 'Edit whitelist rule' : 'Add whitelist rule'}
          </div>
          <div className="font-mono text-roast-dark mt-0.5">
            {initial ? initial.command : 'new rule'}
          </div>
        </div>

        <div className="px-4 py-3 space-y-4">
          <Field
            label="Command"
            hint="Regex/glob matched against the full bash command line (e.g. `^npm run build$`)."
          >
            <input
              type="text"
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="^npm run build$"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-cream-100 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light font-mono"
            />
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-[11px] uppercase tracking-widest text-roast-light">
              Files
              <span className="ml-1 normal-case tracking-normal text-roast-light/70">
                (sha256 hashes are computed server-side on save)
              </span>
            </legend>
            {files.length === 0 && (
              <div className="text-[11px] text-roast-light italic">no files — exec_elevated will reject this rule until at least one executable is hashed</div>
            )}
            {files.map((f, i) => (
              <div key={i} className="bg-cream-100 border border-cream-200 rounded p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={f.path}
                    onChange={e => updateFile(i, { path: e.target.value, exists: undefined, hash: undefined })}
                    onBlur={() => checkFile(i)}
                    placeholder="/usr/local/bin/npm"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 bg-cream-50 border border-cream-200 rounded px-2 py-1 text-xs text-roast-dark placeholder:text-roast-light font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}
                    className="text-[11px] text-status-error hover:underline"
                  >
                    remove
                  </button>
                </div>
                <FileStatus draft={f} />
              </div>
            ))}
            <button
              type="button"
              onClick={() => setFiles(prev => [...prev, { path: '' }])}
              className="text-[11px] text-roast-medium hover:text-roast-dark underline"
            >
              + add file
            </button>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-[11px] uppercase tracking-widest text-roast-light">
              Allowed env passthrough
              <span className="ml-1 normal-case tracking-normal text-roast-light/70">
                (env vars the agent may forward into the command)
              </span>
            </legend>
            <StringListEditor
              values={allowedEnv}
              onChange={setAllowedEnv}
              placeholder="PATH"
            />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-[11px] uppercase tracking-widest text-roast-light">
              Secrets
              <span className="ml-1 normal-case tracking-normal text-roast-light/70">
                (configured secret names this rule may use)
              </span>
            </legend>
            {availableSecrets.length === 0 ? (
              <div className="text-[11px] text-roast-light italic">
                no secrets defined in this project — add them under <code className="font-mono">projects.&lt;name&gt;.secrets</code> in secrets.yaml
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {availableSecrets.map(name => {
                  const on = secrets.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setSecrets(prev => on ? prev.filter(n => n !== name) : [...prev, name])}
                      className={
                        'text-[11px] font-mono rounded px-2 py-1 border transition ' +
                        (on
                          ? 'bg-roast-dark text-cream-50 border-roast-dark'
                          : 'bg-cream-100 text-roast-medium border-cream-200 hover:bg-cream-200')
                      }
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          {error && <div className="text-[11px] text-status-error">{error}</div>}
        </div>

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

function FileStatus({ draft }: { draft: FileDraft }) {
  if (draft.checking) return <div className="text-[10px] text-roast-light">checking…</div>;
  if (draft.error) return <div className="text-[10px] text-status-error">{draft.error}</div>;
  if (draft.path.trim().length === 0) return null;
  if (draft.exists === false) {
    return <div className="text-[10px] text-status-error">file not found</div>;
  }
  if (draft.exists === true && draft.hash) {
    return (
      <div className="text-[10px] text-roast-light font-mono truncate" title={draft.hash}>
        sha256: {draft.hash}
      </div>
    );
  }
  return null;
}

function StringListEditor({
  values, onChange, placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={v}
            onChange={e => onChange(values.map((val, idx) => idx === i ? e.target.value : val))}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-cream-100 border border-cream-200 rounded px-2 py-1 text-xs text-roast-dark placeholder:text-roast-light font-mono"
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, idx) => idx !== i))}
            className="text-[11px] text-status-error hover:underline"
          >
            remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="text-[11px] text-roast-medium hover:text-roast-dark underline"
      >
        + add
      </button>
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
