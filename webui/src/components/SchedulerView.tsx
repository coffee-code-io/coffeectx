/**
 * Scheduler tab.
 *
 * Single source of truth: every job the indexer knows about, split into
 * two buckets by whether the project has it configured in `config.yaml`:
 *
 *   - **Configured** — `projects.<p>.jobs[<name>]` exists. These are the
 *     jobs the user has decided to manage; toggle enabled / trigger a run
 *     / re-configure auth+env+triggers (for user-installed skill jobs).
 *
 *   - **Available** — every other job the indexer can register: hardcoded
 *     built-ins (claude/codex/lsp/plans/local-decisions/lsp-enrichment)
 *     plus user-installed skill jobs under `~/.coffeecode/jobs/` that
 *     haven't been touched yet. Toggling Enable here creates the config
 *     entry on the fly (server-side `setJobEnabled` writes it).
 *
 * The Skills panel that used to live here was dropped — job-shaped skills
 * appear in the unified job list above, and plain agent skills live on
 * the Skills tab.
 */

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

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-medium text-roast-dark">Configured Jobs</h2>
            <div className="text-xs text-roast-light">
              toggling on/off persists to <code className="font-mono">config.yaml</code>;
              ▶ queues an immediate run
            </div>
          </div>
          <JobsPanel filter="configured" />
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-medium text-roast-dark">Available Jobs</h2>
            <div className="text-xs text-roast-light">
              built-ins + skills in <code className="font-mono">~/.coffeecode/jobs/</code> not yet
              in <code className="font-mono">config.yaml</code>
            </div>
          </div>
          <JobsPanel filter="available" />
        </section>
      </div>
    </div>
  );
}
