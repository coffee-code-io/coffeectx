/**
 * HTTP routes for the in-process skill registry + per-project config.
 *
 *   GET  /api/p/:p/skills                 — every loaded skill plus, per
 *                                            (target ∈ {uiAgent,
 *                                            indexingAgents, jobs}), whether
 *                                            it's currently visible to that
 *                                            target. Also exposes the raw
 *                                            include/exclude filter for the
 *                                            UI's editor.
 *   POST /api/p/:p/skills/:name/configure — write the job-side config block
 *                                            (auth, env, triggers, enabled).
 *                                            Only meaningful for skills with
 *                                            `category: 'job'`.
 *   POST /api/p/:p/skills/filter          — body { target, include?, exclude? };
 *                                            writes projects.<p>.skills.<target>.
 *
 * The skill body is intentionally NOT shipped here — pi's ResourceLoader
 * is the canonical surface for that, and the UI catalog page only needs
 * the metadata.
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../dbPool.js';
import {
  loadConfig,
  applySkillFilter,
  resolveSkillFilter,
  type AuthSettings,
  type SkillCategory,
  type SkillFilterTarget,
} from '@coffeectx/core';
import { getSkillRegistry } from '../skillRegistry.js';
import { setJobEnabled, setProjectJobConfig, setProjectSkillFilter } from '../../jobs/control.js';

const FILTER_TARGETS: SkillFilterTarget[] = ['uiAgent', 'indexingAgents', 'jobs'];

export async function registerSkillsRoutes(app: FastifyInstance): Promise<void> {
  // ── List skills (+ per-target visibility) ────────────────────────────────
  app.get<{ Params: { p: string } }>(
    '/api/p/:p/skills',
    async (req, reply) => {
      try { getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const cfg = loadConfig();
      const projectJobs = cfg.projects[req.params.p]?.jobs ?? {};
      const registry = getSkillRegistry();

      // Precompute the per-target visibility set so each row can mark a
      // simple boolean per bucket without re-running the filter logic.
      const visibilityByTarget: Record<SkillFilterTarget, Set<string>> = {
        uiAgent: new Set(),
        indexingAgents: new Set(),
        jobs: new Set(),
      };
      const filters: Record<SkillFilterTarget, { include?: string[]; exclude?: string[] }> = {
        uiAgent: resolveSkillFilter(cfg, req.params.p, 'uiAgent'),
        indexingAgents: resolveSkillFilter(cfg, req.params.p, 'indexingAgents'),
        jobs: resolveSkillFilter(cfg, req.params.p, 'jobs'),
      };
      for (const target of FILTER_TARGETS) {
        for (const s of applySkillFilter(registry, filters[target])) {
          visibilityByTarget[target].add(s.name);
        }
      }

      const skills = registry.map(s => {
        const jobCfg = projectJobs[s.name];
        const envSet = jobCfg?.env ?? {};
        const authSet = jobCfg?.parameters?.['auth'] as AuthSettings | undefined;
        return {
          name: s.name,
          description: s.description ?? null,
          category: s.category as SkillCategory,
          hasJob: !!s.job,
          hasTypes: !!s.typesPath,
          requiredEnv: [...s.requiredEnv],
          /** Names of env vars that ARE currently set in config (values omitted). */
          configuredEnvKeys: Object.keys(envSet),
          /** Current env var values from config.yaml. Surfaced verbatim
           *  because the agent already sees them as literal text in its
           *  prompt — pretending they're secret in the UI would be theater.
           *  When real secret material lands it'll move to a separate
           *  store and stay opaque end-to-end. */
          env: { ...envSet },
          /** Whether the auth block is present and has a model (or is
           *  OAuth, which doesn't require one). */
          authConfigured: !!authSet && (authSet.authType === 'openai-oauth' || !!authSet.model),
          /** Truncated auth summary for display. apiKey deliberately omitted. */
          auth: {
            authType: authSet?.authType ?? null,
            provider: authSet?.provider ?? null,
            url: authSet?.url ?? null,
            model: authSet?.model ?? null,
            hasApiKey: !!authSet?.apiKey,
          },
          /** Config-override triggers, if set. UI shows these as the
           *  current schedule overriding the SKILL.md default. */
          triggers: Array.isArray(jobCfg?.triggers) ? jobCfg!.triggers : null,
          enabled: jobCfg?.enabled ?? false,
          /** Which agent buckets currently load this skill. */
          visibleTo: {
            uiAgent: visibilityByTarget.uiAgent.has(s.name),
            indexingAgents: visibilityByTarget.indexingAgents.has(s.name),
            jobs: visibilityByTarget.jobs.has(s.name),
          },
        };
      });

      return {
        skills,
        filters,
      };
    },
  );

  // ── Configure a single skill's job-side config ───────────────────────────
  app.post<{
    Params: { p: string; name: string };
    Body: {
      enabled?: boolean;
      env?: Record<string, string>;
      auth?: AuthSettings;
      /** `null` clears the override; array (possibly empty) overrides
       *  SKILL.md triggers. Omit to leave existing value. */
      triggers?: unknown[] | null;
    };
  }>(
    '/api/p/:p/skills/:name/configure',
    async (req, reply) => {
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const skill = getSkillRegistry().find(s => s.name === req.params.name);
      if (!skill) { reply.code(404); return { error: `unknown skill "${req.params.name}"` }; }

      try {
        setProjectJobConfig(req.params.p, skill.name, {
          enabled: req.body?.enabled,
          env: req.body?.env,
          auth: req.body?.auth,
          triggers: req.body?.triggers,
        });
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }

      // Mirror `enabled` into the DB so the scheduler picks it up on its
      // next config-poll tick. Only for job-shaped skills.
      if (skill.category === 'job' && req.body?.enabled !== undefined) {
        try {
          const cfg = loadConfig();
          setJobEnabled(db, cfg, req.params.p, skill.name, req.body.enabled);
        } catch (err) {
          reply.code(400);
          return { error: (err as Error).message };
        }
      }

      return { ok: true };
    },
  );

  // ── Edit a per-target skill filter ───────────────────────────────────────
  app.post<{
    Params: { p: string };
    Body: {
      target?: SkillFilterTarget;
      include?: string[] | null;
      exclude?: string[] | null;
    };
  }>(
    '/api/p/:p/skills/filter',
    async (req, reply) => {
      try { getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const target = req.body?.target;
      if (!target || !FILTER_TARGETS.includes(target)) {
        reply.code(400);
        return { error: `target must be one of: ${FILTER_TARGETS.join(', ')}` };
      }

      try {
        setProjectSkillFilter(req.params.p, target, {
          include: req.body?.include,
          exclude: req.body?.exclude,
        });
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }

      return { ok: true };
    },
  );
}
