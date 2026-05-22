import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type JobRow } from '../api/client';
import { useUi } from '../state/store';

export function JobsPanel() {
  const project = useUi(s => s.project);
  const qc = useQueryClient();

  const { data, error } = useQuery({
    queryKey: ['jobs', project],
    queryFn: () => (project ? api.listJobs(project) : Promise.resolve([])),
    enabled: !!project,
    refetchInterval: 2_000,
  });

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.setJobEnabled(project!, name, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', project] }),
  });

  const trigger = useMutation({
    mutationFn: (name: string) => api.triggerJob(project!, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', project] }),
  });

  if (!project) return <div className="text-roast-medium text-sm">Pick a project.</div>;
  if (error) return <div className="text-status-error text-sm">jobs: {(error as Error).message}</div>;
  const jobs = data ?? [];

  return (
    <ul className="space-y-2">
      {jobs.map(job => (
        <JobRowItem
          key={job.name}
          job={job}
          onToggle={() => toggle.mutate({ name: job.name, enabled: !job.enabled })}
          onTrigger={() => trigger.mutate(job.name)}
        />
      ))}
    </ul>
  );
}

function JobRowItem({ job, onToggle, onTrigger }: { job: JobRow; onToggle: () => void; onTrigger: () => void }) {
  const statusColor = {
    running: 'bg-status-warning',
    idle: job.enabled ? 'bg-status-success' : 'bg-cream-300',
    disabled: 'bg-cream-300',
  }[job.status];

  const resultBadge = job.lastResult === 'error'
    ? <span className="text-status-error text-xs">error</span>
    : job.lastResult === 'ok'
    ? <span className="text-status-success text-xs">ok</span>
    : null;

  return (
    <li className="bg-cream-100 border border-cream-200 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
          <span className="font-mono text-roast-dark text-sm truncate" title={job.description ?? job.name}>
            {job.name}
          </span>
          {job.triggerPending && <span className="text-status-warning text-xs">queued</span>}
          {resultBadge}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onTrigger}
            disabled={!job.enabled}
            title="Trigger now"
            className="px-1.5 py-0.5 text-roast-medium hover:text-roast-dark disabled:text-cream-300 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          </button>
          <button
            onClick={onToggle}
            className={
              'px-2 py-0.5 rounded text-xs ' +
              (job.enabled
                ? 'bg-status-success/15 text-status-success hover:bg-status-success/25'
                : 'bg-cream-200 text-roast-medium hover:bg-cream-300')
            }
          >
            {job.enabled ? 'on' : 'off'}
          </button>
        </div>
      </div>
      {(job.lastMessage || job.lastError) && (
        <div className={'text-xs mt-1.5 ' + (job.lastError ? 'text-status-error' : 'text-roast-light')}>
          {job.lastError ?? job.lastMessage}
        </div>
      )}
    </li>
  );
}
