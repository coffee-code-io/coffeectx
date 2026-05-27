/**
 * Secrets tab.
 *
 * View/edit the resolved secrets project in `~/.coffeecode/secrets.yaml`
 * for the active coffeectx project. The mapping coffeectx-project →
 * secrets-project is held in `ProjectEntry.secretsProject` (defaults to
 * the project name); editing the header input updates the indexer config.
 *
 * Secret provider definitions (dotenv/inline/command) stay YAML-managed
 * for v1 — the UI only lists their names. The whitelist of commands is
 * fully editable here; file hashes are computed server-side on save.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type SecretsResponse,
  type WhitelistRuleInput,
  type WhitelistRuleView,
} from '../api/client';
import { useUi } from '../state/store';
import { WhitelistRuleDialog } from './WhitelistRuleDialog';

export function SecretsView() {
  const project = useUi(s => s.project);

  const { data, isLoading, error } = useQuery({
    queryKey: ['secrets', project],
    queryFn: () => (project ? api.getSecrets(project) : Promise.resolve(null)),
    enabled: !!project,
    staleTime: 10_000,
  });

  if (!project) {
    return <div className="p-6 text-roast-medium text-sm">Pick a project.</div>;
  }
  if (isLoading || !data) {
    return <div className="p-6 text-roast-medium text-sm">loading secrets…</div>;
  }
  if (error) {
    return <div className="p-6 text-status-error text-sm">secrets: {(error as Error).message}</div>;
  }

  return (
    <div className="h-full overflow-y-auto bg-cream-50">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <Header project={project} data={data} />

        {!data.exists ? (
          <EmptyState data={data} />
        ) : (
          <>
            <SecretsSection data={data} />
            <WhitelistSection project={project} data={data} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Header (project name + secretsProject editor) ─────────────────────────

function Header({ project, data }: { project: string; data: SecretsResponse }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(data.secretsProject);
  // Reset draft when the server's value changes (after a save) so the
  // input doesn't drift away from canonical.
  useEffect(() => { setDraft(data.secretsProject); }, [data.secretsProject]);

  const setSecretsProject = useMutation({
    mutationFn: (name: string | null) => api.setSecretsProject(project, name),
    onSuccess: (next) => {
      qc.setQueryData(['secrets', project], next);
    },
  });

  const dirty = draft.trim() !== data.secretsProject && draft.trim().length > 0;

  return (
    <header className="bg-cream-100 border border-cream-200 rounded-lg p-4">
      <div className="text-[11px] uppercase tracking-widest text-roast-light">{project}</div>
      <h1 className="text-xl font-semibold text-roast-dark mt-0.5">Secrets</h1>
      <p className="text-sm text-roast-medium mt-1">
        Configure <code className="font-mono">exec_elevated</code> for this project.
        The mapping below decides which entry in <code className="font-mono">{data.configPath}</code> is used at runtime
        — pi processes spawned for this project see it as <code className="font-mono">COFFEECTX_SECRETS_PROJECT</code>.
      </p>

      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1 block">
          <div className="text-[11px] text-roast-medium font-mono mb-0.5">Secrets project</div>
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={project}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-cream-50 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark font-mono"
          />
          <div className="text-[10px] text-roast-light mt-0.5">
            Defaults to the coffeectx project name when blank.
          </div>
        </label>
        <button
          type="button"
          disabled={!dirty || setSecretsProject.isPending}
          onClick={() => setSecretsProject.mutate(draft.trim().length > 0 ? draft.trim() : null)}
          className="px-3 py-1.5 text-sm bg-roast-dark text-cream-50 rounded hover:bg-roast-medium disabled:opacity-40"
        >
          {setSecretsProject.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {setSecretsProject.error && (
        <div className="mt-1 text-[11px] text-status-error">
          {(setSecretsProject.error as Error).message}
        </div>
      )}
    </header>
  );
}

// ── Empty state when secrets.yaml has no matching project ─────────────────

function EmptyState({ data }: { data: SecretsResponse }) {
  return (
    <div className="bg-cream-100 border border-cream-200 rounded-lg p-4 text-sm text-roast-medium space-y-2">
      <div>
        No project named <code className="font-mono text-roast-dark">{data.secretsProject}</code> in{' '}
        <code className="font-mono text-roast-dark">{data.configPath}</code>.
      </div>
      <div>
        Add an entry under <code className="font-mono">projects:</code> there to start whitelisting commands:
      </div>
      <pre className="bg-cream-50 border border-cream-200 rounded p-2 text-[11px] font-mono text-roast-dark overflow-x-auto">
{`projects:
  ${data.secretsProject}:
    directory: /absolute/path/to/repo
    whitelist: []
    secrets: {}`}
      </pre>
    </div>
  );
}

// ── Secrets list (names only) ─────────────────────────────────────────────

function SecretsSection({ data }: { data: SecretsResponse }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-roast-dark mb-2">Secrets</h2>
      <div className="bg-cream-100 border border-cream-200 rounded-lg p-3">
        {data.directory && (
          <div className="text-[11px] text-roast-light mb-2">
            project dir: <code className="font-mono text-roast-medium">{data.directory}</code>
          </div>
        )}
        {data.secretNames.length === 0 ? (
          <div className="text-[12px] text-roast-light italic">
            No secrets defined. Add them under{' '}
            <code className="font-mono">projects.{data.secretsProject}.secrets</code>{' '}
            in <code className="font-mono">{data.configPath}</code>.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.secretNames.map(name => (
              <span key={name} className="text-[11px] font-mono rounded px-2 py-1 bg-cream-200 text-roast-dark">
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Whitelist rules (CRUD) ────────────────────────────────────────────────

function WhitelistSection({ project, data }: { project: string; data: SecretsResponse }) {
  const qc = useQueryClient();
  const [dialogState, setDialogState] = useState<
    | { mode: 'new' }
    | { mode: 'edit'; index: number; rule: WhitelistRuleView }
    | null
  >(null);

  const setData = (next: SecretsResponse) => qc.setQueryData(['secrets', project], next);

  const createMut = useMutation({
    mutationFn: (body: WhitelistRuleInput) => api.createWhitelist(project, body),
    onSuccess: (next) => { setData(next); setDialogState(null); },
  });
  const updateMut = useMutation({
    mutationFn: ({ index, body }: { index: number; body: WhitelistRuleInput }) =>
      api.updateWhitelist(project, index, body),
    onSuccess: (next) => { setData(next); setDialogState(null); },
  });
  const deleteMut = useMutation({
    mutationFn: (index: number) => api.deleteWhitelist(project, index),
    onSuccess: setData,
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-roast-dark">Whitelist</h2>
        <button
          type="button"
          onClick={() => setDialogState({ mode: 'new' })}
          className="text-[12px] px-2 py-1 bg-roast-dark text-cream-50 rounded hover:bg-roast-medium"
        >
          + Add rule
        </button>
      </div>

      {data.whitelist.length === 0 ? (
        <div className="bg-cream-100 border border-cream-200 rounded-lg p-3 text-[12px] text-roast-light italic">
          No whitelist rules. Add one to allow <code className="font-mono">exec_elevated</code> to run a command.
        </div>
      ) : (
        <ul className="space-y-2">
          {data.whitelist.map((rule, i) => (
            <RuleCard
              key={i}
              rule={rule}
              onEdit={() => setDialogState({ mode: 'edit', index: i, rule })}
              onDelete={() => {
                if (!confirm(`Delete rule "${rule.command}"?`)) return;
                deleteMut.mutate(i);
              }}
              busy={deleteMut.isPending}
            />
          ))}
        </ul>
      )}

      {dialogState && (
        <WhitelistRuleDialog
          initial={dialogState.mode === 'edit' ? dialogState.rule : null}
          availableSecrets={data.secretNames}
          project={project}
          onClose={() => setDialogState(null)}
          onSave={async (body) => {
            if (dialogState.mode === 'edit') {
              await updateMut.mutateAsync({ index: dialogState.index, body });
            } else {
              await createMut.mutateAsync(body);
            }
          }}
          submitting={createMut.isPending || updateMut.isPending}
        />
      )}
    </section>
  );
}

function RuleCard({
  rule, onEdit, onDelete, busy,
}: {
  rule: WhitelistRuleView;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const filesOk = rule.files.length > 0 && rule.files.every(f => f.exists && f.matches);
  const hasIssues = rule.files.some(f => !f.exists || f.matches === false);

  return (
    <li className="bg-cream-100 border border-cream-200 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm text-roast-dark break-all">{rule.command}</div>
          <div className="text-[11px] text-roast-light mt-0.5">
            {rule.files.length} file{rule.files.length === 1 ? '' : 's'} ·
            {' '}{rule.allowed_env.length} env ·
            {' '}{rule.secrets.length} secret{rule.secrets.length === 1 ? '' : 's'}
            {' '}
            <StatusBadge ok={filesOk} hasIssues={hasIssues} />
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="text-[11px] text-roast-medium hover:text-roast-dark underline"
          >
            edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-[11px] text-status-error hover:underline disabled:opacity-50"
          >
            delete
          </button>
        </div>
      </div>

      {rule.files.length > 0 && (
        <ul className="space-y-0.5">
          {rule.files.map(f => (
            <li key={f.path} className="text-[11px] font-mono flex items-center gap-2">
              <FileStateDot file={f} />
              <span className="text-roast-medium truncate" title={f.path}>{f.path}</span>
              {f.matches === false && (
                <span className="text-[10px] text-status-error">hash mismatch</span>
              )}
              {f.exists === false && (
                <span className="text-[10px] text-status-error">missing</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {(rule.allowed_env.length > 0 || rule.secrets.length > 0) && (
        <div className="text-[11px] flex flex-wrap gap-1.5">
          {rule.allowed_env.map(e => (
            <span key={`env-${e}`} className="font-mono px-1.5 py-0.5 rounded bg-cream-200 text-roast-medium">
              env:{e}
            </span>
          ))}
          {rule.secrets.map(s => (
            <span key={`sec-${s}`} className="font-mono px-1.5 py-0.5 rounded bg-roast-dark/10 text-roast-dark">
              secret:{s}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function StatusBadge({ ok, hasIssues }: { ok: boolean; hasIssues: boolean }) {
  if (ok) return <span className="text-status-success">· ok</span>;
  if (hasIssues) return <span className="text-status-error">· issues</span>;
  return <span className="text-roast-light">· no files</span>;
}

function FileStateDot({ file }: { file: WhitelistRuleView['files'][number] }) {
  const cls = file.exists === false
    ? 'bg-status-error'
    : file.matches === false
    ? 'bg-status-warning'
    : 'bg-status-success';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}
