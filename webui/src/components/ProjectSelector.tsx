import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUi } from '../state/store';

export function ProjectSelector() {
  const project = useUi(s => s.project);
  const setProject = useUi(s => s.setProject);

  const { data, isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (project || !data?.length) return;
    const enabled = data.filter(p => p.enabled);
    if (enabled.length === 0) return;
    const fav = enabled.find(p => p.isActive) ?? enabled[0]!;
    setProject(fav.name);
  }, [data, project, setProject]);

  if (error) return <span className="text-status-error text-sm">projects: {(error as Error).message}</span>;
  if (isLoading || !data) return <span className="text-roast-medium text-sm">loading…</span>;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-roast-medium">project</span>
      <select
        value={project ?? ''}
        onChange={e => setProject(e.target.value || null)}
        className="bg-cream-100 border border-cream-200 rounded px-2 py-1 text-roast-dark font-medium focus:outline-none focus:ring-2 focus:ring-roast-light"
      >
        <option value="">—</option>
        {data.map(p => (
          <option key={p.name} value={p.name} disabled={!p.enabled || !p.hasDb}>
            {p.name}
            {p.isActive ? ' ★' : ''}
            {!p.enabled ? ' (off)' : ''}
            {!p.hasDb ? ' (no db)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
