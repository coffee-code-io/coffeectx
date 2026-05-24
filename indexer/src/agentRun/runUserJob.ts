/**
 * Fresh-agent runner for user job-shaped skills (i.e. anything under
 * `~/.coffeecode/jobs/<name>/SKILL.md` that the scheduler picks up).
 *
 * Unlike the hardcoded event-stream jobs (see `runEventStreamSkill.ts`)
 * this runner gives the agent NO event-batch context — it just hands over
 * the SKILL.md body as a single user turn and lets the agent loop
 * autonomously against the graph + filesystem (via the standard tool set)
 * until it emits `agent_end`.
 *
 * Each invocation is its own pi session, persisted under
 * `~/.coffeecode/sessions/<project>/jobs/<jobName>/<timestamp>.jsonl` for
 * debugging — old runs aren't pruned automatically (users can rm at will).
 *
 * Skills loaded into the agent: every skill the project's `jobs` bucket
 * filter lets through (see `skillResourceLoader.ts`). Pi surfaces them as
 * `/skill:<name>` slash commands + a system-prompt index.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AuthSettings, Db } from '@coffeectx/core';
import { buildPiAuth } from './auth.js';
import { buildGraphTools } from './piTools.js';
import { buildResourceLoader } from './skillResourceLoader.js';
import { PROJECT_ROOT } from './runEventStreamSkill.js';
import { ProviderError } from './runEventStreamSkill.js';

const SESSION_ROOT = join(homedir(), '.coffeecode', 'sessions');

export interface RunUserJobOptions {
  /** Open Db handle (the scheduler's). */
  db: Db;
  /** Job name (= skill directory name under ~/.coffeecode/jobs/). */
  jobName: string;
  /** Project name. */
  projectName: string;
  /** SKILL.md body — the prompt that drives the agent loop. */
  prompt: string;
  /** Per-job auth (provider/model/apiKey). */
  auth: AuthSettings;
  /** Env var names the skill declared in its front-matter. Their current
   *  `process.env` values get injected as a preamble in front of the prompt
   *  body so the LLM agent (which has no JS sandbox) sees the resolved
   *  values directly instead of asking the user. */
  requiredEnv?: ReadonlyArray<string>;
  /** Scheduler abort signal. Honoured before/after the prompt; pi's
   *  `session.prompt()` doesn't accept signals today. */
  signal?: AbortSignal;
}

export interface RunUserJobResult {
  /** Persisted JSONL path for this run, if any. */
  sessionFile: string | undefined;
  /** Final `agent_end.willRetry` flag, for logging. */
  willRetry: boolean;
}

/**
 * Run one user job once. Resolves when the agent loop exits (or rejects
 * with `ProviderError` if the LLM provider gave up — see
 * `runEventStreamSkill.ts` for the same shape).
 */
export async function runUserJob(opts: RunUserJobOptions): Promise<RunUserJobResult> {
  const { db, jobName, projectName, prompt, auth, requiredEnv, signal } = opts;

  if (signal?.aborted) {
    return { sessionFile: undefined, willRetry: false };
  }

  const fullPrompt = withEnvPreamble(prompt, requiredEnv ?? []);

  const { model, authStorage } = buildPiAuth(auth);

  // One JSONL per run, timestamped — easy to grep / wipe.
  const sessionDir = sessionDirFor(projectName, jobName);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(PROJECT_ROOT, sessionDir);

  console.log(
    `[runUserJob:${jobName}] starting fresh session in ${sessionDir} (model=${model.id})`,
  );

  const customTools: ToolDefinition[] = buildGraphTools(db, {
    allowInsert: true,
    allowFileWrite: true,
  });
  const toolNames = customTools.map(t => t.name);

  const resourceLoader = await buildResourceLoader({
    projectName,
    target: 'jobs',
    cwd: PROJECT_ROOT,
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

  // Same provider-error detection pattern as `runEventStreamSkill.ts`:
  // pi resolves prompt() even on terminal provider errors (402/429/5xx);
  // we have to peek at `agent_end` to know whether the run succeeded.
  type AgentEndSnapshot = { willRetry?: boolean; error?: unknown };
  let lastAgentEnd: AgentEndSnapshot | null = null;
  session.subscribe(ev => {
    if (ev.type === 'agent_end') {
      lastAgentEnd = ev as AgentEndSnapshot;
    }
  });

  try {
    await session.prompt(fullPrompt);
  } catch (err) {
    session.dispose();
    throw err;
  }

  const sessionFile = session.sessionFile;
  // Snapshot through `as` — TS's control-flow analysis doesn't see the
  // closure assignment in `subscribe`, so without the cast it narrows
  // `lastAgentEnd` to its initial `null` type.
  const end = lastAgentEnd as AgentEndSnapshot | null;
  const willRetry = end?.willRetry === true;
  const err = end?.error;
  session.dispose();

  if (err && !willRetry) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`[runUserJob:${jobName}] provider error: ${msg}`);
  }

  return { sessionFile, willRetry };
}

function sessionDirFor(projectName: string, jobName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSION_ROOT, safe(projectName), 'jobs', safe(jobName));
}

/**
 * Prepend an `## Environment` block listing the actual values for each
 * declared env var, so the agent doesn't have to ask the user (it has no
 * JS sandbox to read `process.env` itself). Unset vars are listed as
 * `(unset)` so the agent can fall back / error explicitly. Today's date is
 * also injected to give the agent a stable "now" anchor (relevant for
 * skills like obsidian-worklog that need "yesterday").
 */
function withEnvPreamble(prompt: string, requiredEnv: ReadonlyArray<string>): string {
  const lines: string[] = [];
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  lines.push(`- TODAY = ${yyyy}-${mm}-${dd} (local time)`);
  for (const key of requiredEnv) {
    const val = process.env[key];
    lines.push(val !== undefined ? `- ${key} = ${val}` : `- ${key} = (unset)`);
  }
  return (
    `## Environment\n\n` +
    `The following values are resolved for you — substitute them literally; do not ask the user.\n\n` +
    lines.join('\n') +
    `\n\n---\n\n` +
    prompt
  );
}
