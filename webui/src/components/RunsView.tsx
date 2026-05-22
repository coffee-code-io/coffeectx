import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type JobRunRow } from '../api/client';
import { useUi } from '../state/store';

export function RunsView() {
  const project = useUi(s => s.project);
  const [selected, setSelected] = useState<number | null>(null);

  const runsQ = useQuery({
    queryKey: ['runs', project],
    queryFn: () => (project ? api.listRuns(project, 200) : Promise.resolve([])),
    enabled: !!project,
    refetchInterval: 3_000,
  });

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center text-roast-medium text-sm">
        Pick a project.
      </div>
    );
  }

  return (
    <div className="h-full grid grid-cols-[minmax(380px,1fr)_2fr] min-h-0 overflow-hidden bg-cream-50">
      <RunsList
        runs={runsQ.data ?? []}
        loading={runsQ.isLoading}
        error={runsQ.error as Error | null}
        selected={selected}
        onSelect={setSelected}
      />
      <LogPane project={project} runId={selected} />
    </div>
  );
}

function RunsList({
  runs, loading, error, selected, onSelect,
}: {
  runs: JobRunRow[];
  loading: boolean;
  error: Error | null;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="overflow-y-auto border-r border-cream-200">
      <div className="sticky top-0 bg-cream-100 border-b border-cream-200 px-4 py-2">
        <div className="text-[11px] uppercase tracking-widest text-roast-light">Recent runs</div>
      </div>
      {loading && <div className="p-4 text-sm text-roast-medium">loading…</div>}
      {error && <div className="p-4 text-sm text-status-error">runs: {error.message}</div>}
      {!loading && runs.length === 0 && (
        <div className="p-4 text-sm text-roast-medium">No runs yet.</div>
      )}
      <ul className="divide-y divide-cream-200">
        {runs.map(r => (
          <RunRow key={r.id} run={r} active={r.id === selected} onClick={() => onSelect(r.id)} />
        ))}
      </ul>
    </div>
  );
}

function RunRow({ run, active, onClick }: { run: JobRunRow; active: boolean; onClick: () => void }) {
  const dur = run.endedAt
    ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
    : 'running';
  const resultColor =
    run.result === 'error' ? 'bg-status-error' :
    run.result === 'cancelled' ? 'bg-roast-light' :
    run.result === 'ok' ? 'bg-status-success' :
    'bg-status-warning';

  return (
    <li>
      <button
        onClick={onClick}
        className={
          'w-full px-4 py-2 text-left transition flex items-center gap-3 ' +
          (active ? 'bg-cream-200' : 'hover:bg-cream-100')
        }
      >
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${resultColor}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-roast-dark truncate">{run.jobName}</span>
            <span className="text-[10px] uppercase tracking-wider text-roast-light">{run.triggerKind}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-roast-light font-mono">
            <span>#{run.id}</span>
            <span>·</span>
            <span>{formatAgo(run.startedAt)}</span>
            <span>·</span>
            <span>{dur}</span>
            {run.result && (
              <>
                <span>·</span>
                <span className={run.result === 'error' ? 'text-status-error' : 'text-roast-medium'}>
                  {run.result}
                </span>
              </>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function LogPane({ project, runId }: { project: string; runId: number | null }) {
  const detail = useQuery({
    queryKey: ['run', project, runId],
    queryFn: () => (runId !== null ? api.getRun(project, runId) : Promise.resolve(null)),
    enabled: runId !== null,
    refetchInterval: 2_000,
  });

  if (runId === null) {
    return (
      <div className="h-full flex items-center justify-center text-roast-medium text-sm">
        Select a run on the left to see its log.
      </div>
    );
  }

  const run = detail.data?.run;
  const log = detail.data?.log;

  return (
    <div className="h-full flex flex-col min-h-0 bg-cream-50">
      <div className="border-b border-cream-200 bg-cream-100 px-6 py-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-mono text-roast-dark">run #{runId}</span>
          {run && (
            <>
              <span className="text-[10px] uppercase tracking-widest text-roast-light">
                {run.jobName}
              </span>
              <span className="text-[10px] uppercase tracking-widest text-roast-light">
                {run.triggerKind}
              </span>
              {run.result && (
                <span className={
                  'text-[10px] uppercase tracking-widest ' +
                  (run.result === 'error' ? 'text-status-error' : 'text-status-success')
                }>
                  {run.result}
                </span>
              )}
            </>
          )}
        </div>
        {run && (
          <div className="mt-1 text-[11px] text-roast-light font-mono">
            started {run.startedAt}{run.endedAt && ` · ended ${run.endedAt}`}
          </div>
        )}
        {run?.error && (
          <div className="mt-2 text-sm text-status-error">{run.error}</div>
        )}
        {run?.message && (
          <div className="mt-1 text-sm text-roast-medium">{run.message}</div>
        )}
        {run?.metrics && Object.keys(run.metrics).length > 0 && (
          <div className="mt-1 text-[11px] text-roast-light font-mono">
            metrics: {JSON.stringify(run.metrics)}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 p-4">
        {detail.isLoading && <div className="text-sm text-roast-medium">loading…</div>}
        {detail.error && <div className="text-sm text-status-error">{(detail.error as Error).message}</div>}
        {detail.data && log === null && (
          <div className="text-sm text-roast-medium">No log captured for this run.</div>
        )}
        {log && (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-cream-100 border border-cream-200 rounded-lg p-4 text-roast-dark">
            {log}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.round(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
