/**
 * Per-Span unified-indexer runner.
 *
 * Replaces the old `local-decisions` + `lsp-enrichment` event-stream
 * runners. For each Span at state `linked`:
 *
 *   1. Render the Span as a Markdown document (`formatSpanMd` in core).
 *   2. Spin up a fresh pi.dev session under
 *      `~/.coffeecode/sessions/<project>/indexer__<spanId>/`.
 *   3. Inject the base indexer prompt + a runtime catalog of installed
 *      indexer skills (frontmatter `coffeecode.indexer: true`) into the
 *      system prompt.
 *   4. Send the rendered span as a single `session.prompt(text)` turn.
 *   5. The agent loops autonomously, calling `upsert_entries` (and any
 *      skills it routes to via `/skill:<name>`) until it exits.
 *
 * No batching, no per-event progress watermark — the Span state machine
 * (`linked → indexed`, advanced by the caller) IS the watermark.
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

const SESSION_ROOT = join(homedir(), '.coffeecode', 'sessions');

export interface RunSpanIndexerOptions {
  /** Open Db handle (the scheduler's). */
  db: Db;
  /** Project name. */
  projectName: string;
  /** The Span node id to index. Must be at state `linked`. */
  spanId: string;
  /** Pre-loaded `indexer.md` body. */
  basePrompt: string;
  /** Installed indexer-mode skills, used to build the routing catalog. */
  indexerSkills: ReadonlyArray<Skill>;
  /** Per-job auth (provider/model/apiKey). */
  auth: AuthSettings;
  /** Scheduler abort signal. Honoured before pi prompt and after it returns. */
  signal?: AbortSignal;
}

export interface RunSpanIndexerResult {
  /** Persisted JSONL path for this run, if any. */
  sessionFile: string | undefined;
}

/**
 * Drive one indexer run for one Span. Resolves on agent_end; throws
 * `ProviderError` if the LLM provider gave up after retries.
 */
export async function runSpanIndexer(opts: RunSpanIndexerOptions): Promise<RunSpanIndexerResult> {
  const { db, projectName, spanId, basePrompt, indexerSkills, auth, signal } = opts;

  if (signal?.aborted) return { sessionFile: undefined };

  // Render the span up front — fail fast if the node isn't a Span or has no
  // touched data, before paying for a pi session.
  const spanText = formatSpanMd(db, spanId);

  const { model, authStorage } = buildPiAuth(auth);
  setSecretsProjectEnv(projectName);

  const sessionDir = sessionDirFor(projectName, spanId);
  mkdirSync(sessionDir, { recursive: true });
  const isResuming = hasAnySessionFile(sessionDir);
  const sessionManager = SessionManager.continueRecent(PROJECT_ROOT, sessionDir);

  console.log(
    `[runSpanIndexer] ${isResuming ? 'resuming' : 'new'} session for span ${spanId} ` +
    `in ${sessionDir} (model=${model.id})`,
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

  // Same provider-error detection pattern as the user-job + event-stream
  // runners: pi resolves prompt() even on terminal 402/429/5xx; the
  // willRetry flag on `agent_end` is the only signal.
  type AgentEndSnapshot = { willRetry?: boolean; error?: unknown };
  let lastAgentEnd: AgentEndSnapshot | null = null;
  session.subscribe(ev => {
    if (ev.type === 'agent_end') {
      lastAgentEnd = ev as AgentEndSnapshot;
    }
  });

  try {
    await session.prompt(spanText);
  } catch (err) {
    session.dispose();
    throw err;
  }

  const sessionFile = session.sessionFile;
  const end = lastAgentEnd as AgentEndSnapshot | null;
  const willRetry = end?.willRetry === true;
  const err = end?.error;
  session.dispose();

  if (err && !willRetry) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`[runSpanIndexer] provider error on span ${spanId}: ${msg}`);
  }

  return { sessionFile };
}

function sessionDirFor(projectName: string, spanId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSION_ROOT, safe(projectName), `indexer__${safe(spanId)}`);
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
