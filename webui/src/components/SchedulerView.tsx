import { SchedulerDot } from './SchedulerDot';
import { JobsPanel } from './JobsPanel';
import { useUi } from '../state/store';

export function SchedulerView() {
  const project = useUi(s => s.project);

  return (
    <div className="h-full overflow-y-auto bg-cream-50">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {/* Status header */}
        <header className="bg-cream-100 border border-cream-200 rounded-lg p-4 flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-roast-light">
              {project ?? '—'}
            </div>
            <h1 className="text-xl font-semibold text-roast-dark mt-0.5">Scheduler</h1>
          </div>
          <SchedulerDot verbose />
        </header>

        {/* Jobs */}
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-medium text-roast-dark">Jobs</h2>
            <div className="text-xs text-roast-light">
              toggling on/off persists to <code className="font-mono">config.yaml</code>;
              ▶ queues an immediate run
            </div>
          </div>
          <JobsPanel />
        </section>

        {/* Placeholder for future scheduler features */}
        <section className="bg-cream-100 border border-cream-200 rounded-lg p-4 text-sm text-roast-medium">
          <div className="text-[11px] uppercase tracking-widest text-roast-light mb-1">Coming soon</div>
          Run history, per-job state, restart controls, and per-trigger metrics will land in
          this view next.
        </section>
      </div>
    </div>
  );
}
