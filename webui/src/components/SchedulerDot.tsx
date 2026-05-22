import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUi } from '../state/store';

export function SchedulerDot({ verbose = false }: { verbose?: boolean }) {
  const project = useUi(s => s.project);
  const { data } = useQuery({
    queryKey: ['scheduler', project],
    queryFn: () => (project ? api.scheduler(project) : Promise.resolve(null)),
    enabled: !!project,
    refetchInterval: 2_000,
  });

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-sm text-roast-medium">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-cream-300" />
        scheduler: unknown
      </div>
    );
  }

  const color = data.alive ? 'bg-status-success' : 'bg-status-error';
  const ago = data.lastSeenAt ? formatAgo(data.lastSeenAt) : 'never';
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-roast-dark font-medium">scheduler {data.alive ? 'alive' : 'down'}</span>
      {verbose && (
        <span className="text-roast-light text-xs">
          last seen {ago}{data.pid ? ` · pid ${data.pid}` : ''}
        </span>
      )}
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}
