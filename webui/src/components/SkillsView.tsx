/**
 * Skills tab.
 *
 * Scoped to plain agent skills under `~/.coffeecode/skills/` only
 * (category === 'skill'). Job-shaped skills under `~/.coffeecode/jobs/`
 * live on the Scheduler tab; surfacing them here too would just duplicate
 * the same metadata under two tabs.
 *
 * Two-section layout:
 *
 *   1. **Agents** — one card per filter target (`uiAgent`, `indexingAgents`,
 *      `jobs`). Each card shows which plain skills currently load into
 *      that agent and lets the user toggle skills on/off via a per-row
 *      checkbox. Toggling translates to an exclude-list mutation (default:
 *      every skill visible unless excluded) so the config diff stays
 *      minimal and additive.
 *
 *   2. **Catalog** — a single table of every installed plain skill with
 *      capability badges and the three "loaded into" booleans rendered as
 *      cells.
 *
 * The filter editor is intentionally simple: it always operates in
 * "exclude" mode (whitelist mode is reserved for power users editing
 * config.yaml directly). This keeps the UI's mental model "all skills are
 * available by default; check the ones you want to hide from each agent".
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type SkillInfo,
  type SkillFilter,
  type SkillFilterTarget,
} from '../api/client';
import { useUi } from '../state/store';

const TARGETS: { id: SkillFilterTarget; label: string; hint: string }[] = [
  { id: 'uiAgent',        label: 'UI agent',         hint: 'Right-sidebar chat' },
  { id: 'indexingAgents', label: 'Indexing agents',  hint: 'local-decisions, lsp-enrichment' },
  { id: 'jobs',           label: 'User jobs',        hint: 'Skills under ~/.coffeecode/jobs/' },
];

export function SkillsView() {
  const project = useUi(s => s.project);

  const { data, isLoading, error } = useQuery({
    queryKey: ['skills', project],
    queryFn: () => (project ? api.listSkills(project) : Promise.resolve(null)),
    enabled: !!project,
    staleTime: 10_000,
  });

  if (!project) {
    return <div className="p-6 text-roast-medium text-sm">Pick a project.</div>;
  }
  if (isLoading || !data) {
    return <div className="p-6 text-roast-medium text-sm">loading skills…</div>;
  }
  if (error) {
    return <div className="p-6 text-status-error text-sm">skills: {(error as Error).message}</div>;
  }

  // Only plain agent skills here — job-shaped skills live on the Scheduler tab.
  const plainSkills = data.skills.filter(s => s.category === 'skill');

  return (
    <div className="h-full overflow-y-auto bg-cream-50">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <header className="bg-cream-100 border border-cream-200 rounded-lg p-4">
          <div className="text-[11px] uppercase tracking-widest text-roast-light">{project}</div>
          <h1 className="text-xl font-semibold text-roast-dark mt-0.5">Skills</h1>
          <p className="text-sm text-roast-medium mt-1">
            Agent skills installed under <code className="font-mono">~/.coffeecode/skills/</code>.
            Each agent loads the skill set you opt it into below. Job-shaped skills under{' '}
            <code className="font-mono">~/.coffeecode/jobs/</code> live on the Scheduler tab.
          </p>
        </header>

        {plainSkills.length === 0 ? (
          <div className="bg-cream-100 border border-cream-200 rounded-lg p-4 text-sm text-roast-medium">
            No skills installed. Drop a directory containing <code className="font-mono">SKILL.md</code>{' '}
            into <code className="font-mono">~/.coffeecode/skills/</code> and restart the indexer.
          </div>
        ) : (
          <>
            <AgentSection project={project} skills={plainSkills} filters={data.filters} />
            <CatalogSection skills={plainSkills} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Agent assignment cards ────────────────────────────────────────────────

function AgentSection({
  project, skills, filters,
}: {
  project: string;
  skills: SkillInfo[];
  filters: Record<SkillFilterTarget, SkillFilter>;
}) {
  const qc = useQueryClient();
  const setFilter = useMutation({
    mutationFn: (patch: Parameters<typeof api.setSkillFilter>[1]) =>
      api.setSkillFilter(project, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', project] }),
  });

  return (
    <section>
      <h2 className="text-sm font-medium text-roast-dark mb-2">Agents</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {TARGETS.map(t => (
          <AgentCard
            key={t.id}
            target={t}
            skills={skills}
            filter={filters[t.id] ?? {}}
            onToggle={(skillName, on) => {
              // Exclude-mode edit: if on=true, drop the name from exclude;
              // if on=false, add it.
              const prev = filters[t.id]?.exclude ?? [];
              const next = on
                ? prev.filter(n => n !== skillName)
                : prev.includes(skillName) ? prev : [...prev, skillName];
              setFilter.mutate({ target: t.id, exclude: next });
            }}
          />
        ))}
      </div>
    </section>
  );
}

function AgentCard({
  target, skills, filter, onToggle,
}: {
  target: { id: SkillFilterTarget; label: string; hint: string };
  skills: SkillInfo[];
  filter: { include?: string[]; exclude?: string[] };
  onToggle: (skillName: string, on: boolean) => void;
}) {
  const usingWhitelist = (filter.include?.length ?? 0) > 0;

  // Visibility for this target — recomputed against the same rule the
  // server applies. We could read the per-skill `visibleTo` flag, but
  // recomputing keeps the checkboxes responsive between mutation +
  // invalidation refetch.
  function isVisible(s: SkillInfo): boolean {
    if (usingWhitelist) return filter.include!.includes(s.name);
    return !(filter.exclude ?? []).includes(s.name);
  }

  return (
    <div className="bg-cream-100 border border-cream-200 rounded-lg p-3 space-y-2">
      <div>
        <div className="text-sm font-medium text-roast-dark">{target.label}</div>
        <div className="text-[11px] text-roast-light">{target.hint}</div>
      </div>
      {usingWhitelist && (
        <div className="text-[11px] text-status-warning">
          whitelist mode (include list set in config) — edit{' '}
          <code className="font-mono">~/.coffeecode/config.yaml</code> directly to leave it.
        </div>
      )}
      <ul className="space-y-1">
        {skills.length === 0 ? (
          <li className="text-[12px] text-roast-light italic">no skills installed</li>
        ) : skills.map(s => (
          <li key={s.name}>
            <label className="flex items-center gap-2 text-[12px] text-roast-dark">
              <input
                type="checkbox"
                checked={isVisible(s)}
                disabled={usingWhitelist}
                onChange={e => onToggle(s.name, e.target.checked)}
                className="accent-roast-dark"
              />
              <span className="font-mono truncate">{s.name}</span>
              <CategoryBadge category={s.category} />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Catalog table ─────────────────────────────────────────────────────────

function CatalogSection({ skills }: { skills: SkillInfo[] }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-roast-dark mb-2">Catalog</h2>
      <div className="bg-cream-100 border border-cream-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-cream-200 text-roast-medium">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Skill</th>
              <th className="px-3 py-2 font-medium">Capabilities</th>
              <th className="px-3 py-2 font-medium text-center">UI</th>
              <th className="px-3 py-2 font-medium text-center">Idx</th>
              <th className="px-3 py-2 font-medium text-center">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {skills.map(s => (
              <CatalogRow key={s.name} skill={s} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CatalogRow({ skill }: { skill: SkillInfo }) {
  const setTab = useUi(s => s.setTab);
  const [showInfo, setShowInfo] = useState(false);

  return (
    <>
      <tr className="border-t border-cream-200 align-top">
        <td className="px-3 py-2 min-w-[160px]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowInfo(v => !v)}
              className="font-mono text-roast-dark text-left hover:underline"
              title={skill.description ?? skill.name}
            >
              {skill.name}
            </button>
            <CategoryBadge category={skill.category} />
          </div>
          {skill.description && (
            <div className="text-[11px] text-roast-medium mt-0.5 line-clamp-2">{skill.description}</div>
          )}
        </td>
        <td className="px-3 py-2 text-[11px] text-roast-light space-x-1">
          {skill.hasJob && <CapBadge>job</CapBadge>}
          {skill.hasTypes && <CapBadge>types</CapBadge>}
          {skill.requiredEnv.length > 0 && <CapBadge>env</CapBadge>}
          {skill.category === 'job' && (
            <button
              onClick={() => setTab('scheduler')}
              className="ml-2 text-roast-medium hover:text-roast-dark underline"
              title="Configure auth + env + triggers on the Scheduler tab"
            >
              configure
            </button>
          )}
        </td>
        <Dot on={skill.visibleTo.uiAgent} />
        <Dot on={skill.visibleTo.indexingAgents} />
        <Dot on={skill.visibleTo.jobs} />
      </tr>
      {showInfo && (
        <tr className="border-t border-cream-200 bg-cream-50">
          <td colSpan={5} className="px-3 py-2 text-[12px] text-roast-medium space-y-1">
            <div><strong className="text-roast-dark">Source:</strong> ~/.coffeecode/{skill.category === 'job' ? 'jobs' : 'skills'}/{skill.name}/SKILL.md</div>
            {skill.requiredEnv.length > 0 && (
              <div>
                <strong className="text-roast-dark">Required env:</strong>{' '}
                {skill.requiredEnv.map(k => (
                  <code key={k} className={
                    'font-mono ml-1 ' + (skill.configuredEnvKeys.includes(k) ? 'text-roast-dark' : 'text-status-warning')
                  }>
                    {k}{skill.configuredEnvKeys.includes(k) ? '' : '*'}
                  </code>
                ))}
                <span className="text-[10px] text-roast-light ml-2">(* = not configured)</span>
              </div>
            )}
            {skill.hasJob && (
              <div>
                <strong className="text-roast-dark">Job:</strong>{' '}
                {skill.enabled ? <span className="text-status-success">enabled</span> : <span>disabled</span>}
                {skill.triggers && <span className="ml-2">({skill.triggers.length} trigger override(s) from config)</span>}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category: 'skill' | 'job' }) {
  const cls = category === 'job'
    ? 'bg-roast-dark text-cream-50'
    : 'bg-cream-200 text-roast-medium';
  return (
    <span className={`text-[10px] uppercase tracking-wider rounded px-1 py-px ${cls}`}>{category}</span>
  );
}

function CapBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider rounded bg-cream-200 text-roast-medium px-1 py-px">
      {children}
    </span>
  );
}

function Dot({ on }: { on: boolean }) {
  return (
    <td className="px-3 py-2 text-center">
      <span
        className={
          'inline-block w-2.5 h-2.5 rounded-full ' +
          (on ? 'bg-status-success' : 'bg-cream-300')
        }
      />
    </td>
  );
}
