/**
 * Jobs list for the Scheduler tab.
 *
 * Splits the unified job list (built-ins + user-installed skill jobs) by
 * the `configured` flag the server attaches to each row:
 *   - `filter="configured"` → only jobs that already have an entry in
 *     `projects.<p>.jobs[<name>]`
 *   - `filter="available"`  → every other job (built-in + uninstalled
 *     user skill jobs)
 *   - omitted               → show everything (legacy callers)
 *
 * For user-installed skill jobs (`category === 'user'`) we surface a
 * Configure button that opens the auth / env / triggers dialog.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type JobRow, type SkillInfo, type SkillConfigurePatch } from '../api/client';
import { useUi } from '../state/store';
import { SkillConfigureDialog } from './SkillConfigureDialog';

type JobFilter = 'configured' | 'available';

interface Props {
  filter?: JobFilter;
}

export function JobsPanel({ filter }: Props) {
  const project = useUi(s => s.project);
  const qc = useQueryClient();
  const [configuring, setConfiguring] = useState<SkillInfo | null>(null);

  const { data: jobs, error } = useQuery({
    queryKey: ['jobs', project],
    queryFn: () => (project ? api.listJobs(project) : Promise.resolve([])),
    enabled: !!project,
    refetchInterval: 2_000,
  });

  // Skill metadata needed to populate the Configure dialog. Cheap to keep
  // alongside the jobs query; same project key keeps invalidation simple.
  const { data: skillsData } = useQuery({
    queryKey: ['skills', project],
    queryFn: () => (project ? api.listSkills(project) : Promise.resolve(null)),
    enabled: !!project,
    staleTime: 10_000,
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

  const configure = useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: SkillConfigurePatch }) =>
      api.configureSkill(project!, name, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', project] });
      qc.invalidateQueries({ queryKey: ['jobs', project] });
    },
  });

  if (!project) return <div className="text-roast-medium text-sm">Pick a project.</div>;
  if (error) return <div className="text-status-error text-sm">jobs: {(error as Error).message}</div>;
  const all = jobs ?? [];
  const visible = filter === undefined
    ? all
    : filter === 'configured'
      ? all.filter(j => j.configured)
      : all.filter(j => !j.configured);

  if (visible.length === 0) {
    return (
      <div className="bg-cream-100 border border-cream-200 rounded-lg p-3 text-sm text-roast-medium">
        {filter === 'configured'
          ? 'No configured jobs yet — enable one from the Available section below.'
          : filter === 'available'
            ? 'Nothing available — every known job is already configured.'
            : 'No jobs registered.'}
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {visible.map(job => (
          <JobRowItem
            key={job.name}
            job={job}
            onToggle={() => toggle.mutate({ name: job.name, enabled: !job.enabled })}
            onTrigger={() => trigger.mutate(job.name)}
            onConfigure={() => {
              const s = skillsData?.skills.find(s => s.name === job.name);
              if (s) setConfiguring(s);
            }}
          />
        ))}
      </ul>

      {configuring && (
        <SkillConfigureDialog
          skill={configuring}
          onClose={() => setConfiguring(null)}
          onSave={async (patch) => {
            await configure.mutateAsync({ name: configuring.name, patch });
            setConfiguring(null);
          }}
          submitting={configure.isPending}
        />
      )}
    </>
  );
}

function JobRowItem({
  job, onToggle, onTrigger, onConfigure,
}: {
  job: JobRow;
  onToggle: () => void;
  onTrigger: () => void;
  onConfigure: () => void;
}) {
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
          {job.category === 'user' && (
            <span className="text-[10px] uppercase tracking-wider rounded bg-cream-200 text-roast-medium px-1 py-px">
              skill
            </span>
          )}
          {job.triggerPending && <span className="text-status-warning text-xs">queued</span>}
          {resultBadge}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {job.category === 'user' && (
            <button
              onClick={onConfigure}
              className="px-2 py-0.5 rounded text-xs bg-cream-200 text-roast-dark hover:bg-cream-300"
              title="Auth / env / triggers"
            >
              Configure
            </button>
          )}
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
