/**
 * Per-agent-session unified-indexer runner.
 *
 * Replaces the old per-Span runner. Earlier spans in a coding-agent
 * conversation are routinely load-bearing context for later spans
 * (cross-span reasoning, recurring decisions). Re-using one pi.dev
 * session per agent `sessionId` (instead of per `spanId`) lets the model
 * see what it already indexed without having to re-derive it.
 *
 * Lifecycle per call:
 *   1. Open / resume `~/.coffeecode/sessions/<project>/indexer__<sessionId>/`.
 *   2. Wire graph tools + the indexer-skill routing catalog into the
 *      system prompt.
 *   3. For each Span in `opts.spans` (caller pre-sorts oldest-first):
 *      a. Render via `formatSpanMd(db, span.id)`.
 *      b. `await session.prompt(text)` — the agent loops until
 *         `agent_end`, calling `upsert_entries` for whatever it wants
 *         to record (and skill-routing as needed).
 *      c. Post-span hook: `sealAndPropagateComments(db, span.id)` seals
 *         any LSP-symbol comments the agent wrote and propagates them
 *         to newer versions on the same timeline.
 *      d. `await onSpanIndexed(span.id)` — the registry advances Span
 *         state to `indexed` here.
 *   4. Honour `signal.aborted` between spans; stop cleanly.
 *
 * If turn N fails (`ProviderError`), spans 1..N-1 are indexed, N stays
 * `linked`, N+1..end are deferred. The fallback timer / next trigger
 * picks them up.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AuthSettings, Db, Skill } from '@coffeectx/core';
import { formatSpanMd } from '@coffeectx/core';
import { buildPiAuth } from './auth.js';
import { buildGraphTools } from './piTools.js';
import { buildResourceLoader } from './skillResourceLoader.js';
import { PROJECT_ROOT, ProviderError } from './common.js';
import { maybeExecElevatedTool, setSecretsProjectEnv } from './secretsTool.js';
import { sealAndPropagateComments } from './sealComments.js';

const SESSION_ROOT = join(homedir(), '.coffeecode', 'sessions');

export interface RunSessionIndexerOptions {
  /** Open Db handle (the scheduler's). */
  db: Db;
  /** Project name. */
  projectName: string;
  /** The agent sessionId that groups these spans. Drives session dir. */
  sessionId: string;
  /** Spans for this agent session, pre-sorted oldest-first by startedAt.
   *  Each must already be at state `linked`. */
  spans: ReadonlyArray<{ id: string; startedAt: number }>;
  /** Pre-loaded `indexer.md` body. */
  basePrompt: string;
  /** Installed indexer-mode skills, used to build the routing catalog. */
  indexerSkills: ReadonlyArray<Skill>;
  /** Per-job auth (provider/model/apiKey). */
  auth: AuthSettings;
  /** Scheduler abort signal. Honoured between spans; pi's prompt() itself
   *  doesn't accept a signal today. */
  signal?: AbortSignal;
  /** Called after each span's post-span hook succeeds. The registry
   *  advances Span state to `indexed` here. */
  onSpanIndexed: (spanId: string) => void | Promise<void>;
}

export interface RunSessionIndexerResult {
  /** Persisted JSONL path for this run, if any. */
  sessionFile: string | undefined;
  /** How many spans had their full pipeline run successfully (turn +
   *  post-span hook + onSpanIndexed). */
  indexed: number;
}

export async function runSessionIndexer(
  opts: RunSessionIndexerOptions,
): Promise<RunSessionIndexerResult> {
  const { db, projectName, sessionId, spans, basePrompt, indexerSkills, auth, signal, onSpanIndexed } = opts;

  if (signal?.aborted) return { sessionFile: undefined, indexed: 0 };
  if (spans.length === 0) return { sessionFile: undefined, indexed: 0 };

  const { model, authStorage } = buildPiAuth(auth);
  setSecretsProjectEnv(projectName);

  const sessionDir = sessionDirFor(projectName, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const isResuming = hasAnySessionFile(sessionDir);
  const sessionManager = SessionManager.continueRecent(PROJECT_ROOT, sessionDir);

  console.log(
    `[runSessionIndexer] ${isResuming ? 'resuming' : 'new'} session for agent-session ${sessionId} ` +
    `(${spans.length} span(s)) in ${sessionDir} (model=${model.id})`,
  );

  // Graph tools only — no FS access. `noTools: 'builtin'` already gates
  // pi's read/bash/edit/write.
  const customTools: ToolDefinition[] = [
    ...buildGraphTools(db, {
      allowInsert: true,
      allowFileWrite: false,
    }),
    ...maybeExecElevatedTool(),
  ];
  const toolNames = customTools.map(t => t.name);

  const skillCatalog = renderSkillCatalog(indexerSkills);
  const resourceLoader = await buildResourceLoader({
    projectName,
    target: 'indexingAgents',
    cwd: PROJECT_ROOT,
    appendSystemPrompt: skillCatalog ? [basePrompt, skillCatalog] : [basePrompt],
  });

  const { session } = await createAgentSession({
    cwd: PROJECT_ROOT,
    model,
    authStorage,
    sessionManager,
    customTools,
    tools: toolNames,
    noTools: 'builtin',
    resourceLoader,
  });

  // Same provider-error detection pattern as the other runners: pi
  // resolves prompt() even on terminal 402/429/5xx; the `willRetry` flag
  // on the most recent `agent_end` is the only signal.
  type AgentEndSnapshot = { willRetry?: boolean; error?: unknown };
  let lastAgentEnd: AgentEndSnapshot | null = null;
  session.subscribe(ev => {
    if (ev.type === 'agent_end') {
      lastAgentEnd = ev as AgentEndSnapshot;
    }
  });

  let indexed = 0;
  try {
    for (const span of spans) {
      if (signal?.aborted) {
        console.log(`[runSessionIndexer] aborted before span ${span.id}`);
        break;
      }

      const spanText = formatSpanMd(db, span.id);
      lastAgentEnd = null;
      await session.prompt(spanText);

      // Cast through `as` — TS's control-flow doesn't see the closure
      // assignment in `subscribe`, so without the cast `lastAgentEnd`
      // narrows to its initial `null`.
      const end = lastAgentEnd as AgentEndSnapshot | null;
      const willRetry = end?.willRetry === true;
      const err = end?.error;
      if (err && !willRetry) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ProviderError(
          `[runSessionIndexer] provider error on span ${span.id}: ${msg}`,
        );
      }

      // Post-span hook: seal touched LSP comments + propagate forward.
      // Run BEFORE onSpanIndexed so a hook failure doesn't leave a span
      // marked `indexed` without its sealing pass.
      sealAndPropagateComments(db, span.id);

      try {
        await onSpanIndexed(span.id);
      } catch (cbErr) {
        // Abort during scheduler shutdown may close the DB before this
        // fires; treat that as expected.
        if (!signal?.aborted) {
          console.warn(`[runSessionIndexer] onSpanIndexed failed for ${span.id}: ${(cbErr as Error).message}`);
        }
      }
      indexed++;
    }
  } finally {
    session.dispose();
  }

  return { sessionFile: session.sessionFile, indexed };
}

function sessionDirFor(projectName: string, sessionId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSION_ROOT, safe(projectName), `indexer__${safe(sessionId)}`);
}

function hasAnySessionFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try { return readdirSync(dir).some(f => f.endsWith('.jsonl')); }
  catch { return false; }
}

/**
 * Render the "available indexer skills" routing catalog appended to the
 * base prompt. Each skill contributes its name + description; the agent
 * reads this list and decides whether to invoke `/skill:<name>` for the
 * current span. Returns null when there are no indexer skills installed.
 */
function renderSkillCatalog(skills: ReadonlyArray<Skill>): string | null {
  if (skills.length === 0) return null;
  // Deterministic order — alphabetical by name. Avoids prompt churn when
  // the filesystem returns the dirs in a different order between runs.
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`# Available indexer skills`, ''];
  for (const s of sorted) {
    const desc = s.description ?? '(no description)';
    lines.push(`- \`/skill:${s.name}\` — ${desc}`);
  }
  lines.push('');
  lines.push('Invoke one of the above with `/skill:<name>` BEFORE producing `upsert_entries` calls when the span matches the skill\'s description.');
  return lines.join('\n');
}
