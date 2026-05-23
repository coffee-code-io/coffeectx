/**
 * Scheduler runtime.
 *
 * Owns:
 *   - registering jobs into the DB on startup
 *   - reconciling config → DB (config wins on boot)
 *   - timer + onTypeInsert dispatch with debounce
 *   - startup catch-up for onTypeInsert via the catch-up cursor in jobs.state_json
 *   - trigger-pending polling (the bridge from CLI `job trigger`)
 *   - config-change polling (toggle enabled without restart)
 *   - a single global mutex: at most one job runs at a time
 */

import { loadConfig, resolveJobParameters, type Db, type CoffeectxConfig, type ProjectEntry, type NodeEvent } from '@coffeectx/core';
import type { Job, JobContext, JobTrigger } from './types.js';
import { withRunLog } from './runLog.js';

const DEBOUNCE_MS = 1_500;
const TRIGGER_POLL_MS = 2_000;
const CONFIG_POLL_MS = 5_000;
const HEARTBEAT_MS = 2_000;
const SHUTDOWN_GRACE_MS = 15_000;

interface ProjectInfo extends ProjectEntry {
  name: string;
}

interface PendingTrigger {
  kind: 'timer' | 'onTypeInsert' | 'onNodeState' | 'manual' | 'startup';
}

interface JobState {
  pending: PendingTrigger | null;
  debounceTimer: NodeJS.Timeout | null;
  timerHandle: NodeJS.Timeout | null;
  cursorTypes: string[] | null; // set for jobs that have an onTypeInsert trigger
}

export interface SchedulerOptions {
  db: Db;
  dbPath: string;
  project: ProjectInfo;
  jobs: Job[];
}

export class Scheduler {
  private readonly db: Db;
  private readonly dbPath: string;
  private readonly project: ProjectInfo;
  private readonly jobs = new Map<string, Job>();
  private readonly state = new Map<string, JobState>();
  private readonly abortController = new AbortController();

  private config: CoffeectxConfig;
  private running = false;
  private currentJob: string | null = null;
  private unsubscribeNodeEvents?: () => void;
  private triggerPollHandle: NodeJS.Timeout | null = null;
  private configPollHandle: NodeJS.Timeout | null = null;
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private stopping = false;
  private hardKillHandle: NodeJS.Timeout | null = null;

  constructor(opts: SchedulerOptions) {
    this.db = opts.db;
    this.dbPath = opts.dbPath;
    this.project = opts.project;
    this.config = loadConfig();
    for (const job of opts.jobs) {
      this.jobs.set(job.name, job);
      this.state.set(job.name, {
        pending: null,
        debounceTimer: null,
        timerHandle: null,
        cursorTypes: collectInsertTypes(job.triggers),
      });
    }
  }

  /**
   * Start the scheduler. Resolves when shutdown completes (SIGINT/SIGTERM).
   * Runs forever otherwise.
   */
  async start(): Promise<void> {
    this.log('starting');

    // 1. Clear any 'running' status left over from an unclean shutdown.
    const stale = this.db.clearStaleRunning();
    if (stale > 0) this.log(`reclaimed ${stale} stale running job(s)`);

    // 1b. Begin emitting heartbeats so the web UI shows us alive.
    this.db.writeHeartbeat(process.pid);
    this.heartbeatHandle = setInterval(() => {
      try { this.db.writeHeartbeat(process.pid); }
      catch (err) { this.log(`heartbeat write failed: ${(err as Error).message}`); }
    }, HEARTBEAT_MS);

    // 2. Register every job in the DB; reconcile enabled from project config.
    const projectJobs = this.config.projects[this.project.name]?.jobs ?? {};
    for (const job of this.jobs.values()) {
      const created = this.db.upsertJob(job.name, { description: job.description, defaultEnabled: job.defaultEnabled });
      const cfgEntry = projectJobs[job.name];
      if (cfgEntry?.enabled !== undefined) {
        this.db.setJobEnabled(job.name, cfgEntry.enabled);
      } else if (created) {
        this.db.setJobEnabled(job.name, job.defaultEnabled);
      }
    }

    // 3. Subscribe to node-lifecycle events (insert + state-change).
    this.unsubscribeNodeEvents = this.db.onNodeEvent(event => this.onNodeEvent(event));

    // 4. Wire timers for enabled jobs.
    for (const job of this.jobs.values()) this.installTimers(job);

    // 5. Startup catch-up: fire onTypeInsert jobs that have new matching nodes.
    this.startupCatchup();

    // 6. Polling loops.
    this.triggerPollHandle = setInterval(() => this.pollTriggerPending(), TRIGGER_POLL_MS);
    this.configPollHandle = setInterval(() => this.pollConfig(), CONFIG_POLL_MS);

    // 7. Shutdown hooks. A second SIGINT short-circuits to an immediate exit
    // — pi-coding-agent's `session.prompt()` doesn't honour AbortSignal and
    // we want Ctrl-C-twice to behave like Ctrl-C-then-Ctrl-C in any other CLI.
    const shutdown = (sig: string) => { this.log(`received ${sig}, shutting down`); void this.shutdown(); };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 8. Block forever (resolved by shutdown()).
    await new Promise<void>(resolve => {
      this.abortController.signal.addEventListener('abort', () => resolve());
    });
    this.log('stopped');
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) {
      // Second SIGINT/SIGTERM — user wants out NOW. Don't bother trying to
      // unwind anything; pi-coding-agent's session.prompt() is hopeless to
      // cancel cooperatively.
      this.log('second shutdown signal — force exit');
      process.exit(1);
    }
    this.stopping = true;

    // Hard deadline: if the grace loop hasn't released us within
    // SHUTDOWN_GRACE_MS, force-exit. Unrefed so it doesn't keep the loop alive.
    this.hardKillHandle = setTimeout(() => {
      console.error('[scheduler] shutdown timeout — force exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    this.hardKillHandle.unref();

    this.unsubscribeNodeEvents?.();
    if (this.triggerPollHandle) clearInterval(this.triggerPollHandle);
    if (this.configPollHandle) clearInterval(this.configPollHandle);
    if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
    for (const st of this.state.values()) {
      if (st.timerHandle) clearInterval(st.timerHandle);
      if (st.debounceTimer) clearTimeout(st.debounceTimer);
    }

    // Signal in-flight jobs to stop, then wait for them to honour it.
    this.abortController.abort();
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.running && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    // Only close the DB if the job actually finished. If it's still spinning
    // (pi-coding-agent ignoring the signal), leaving the handle open avoids
    // the "database connection is not open" stderr spam from late writes —
    // the hard-kill watchdog will terminate the process anyway.
    if (!this.running) {
      try { this.db.close(); } catch { /* idempotent */ }
    } else {
      this.log(`job "${this.currentJob}" still running after grace; deferring db.close to watchdog`);
    }
  }

  // ── Trigger plumbing ──────────────────────────────────────────────────────

  private installTimers(job: Job): void {
    const st = this.state.get(job.name)!;
    if (st.timerHandle) { clearInterval(st.timerHandle); st.timerHandle = null; }
    const row = this.db.getJob(job.name);
    if (!row?.enabled) return;
    for (const trig of job.triggers) {
      if (trig.kind !== 'timer') continue;
      // First fire after the interval, not immediately — keeps boot quiet.
      st.timerHandle = setInterval(() => this.enqueue(job.name, { kind: 'timer' }), trig.intervalMs);
    }
  }

  private onNodeEvent(event: NodeEvent): void {
    if (event.typeNames.length === 0) return;
    if (event.kind === 'insert') {
      const matched = new Set<string>();
      for (const job of this.jobs.values()) {
        for (const trig of job.triggers) {
          if (trig.kind !== 'onTypeInsert') continue;
          if (trig.typeNames.some(t => event.typeNames.includes(t))) {
            matched.add(job.name);
            break;
          }
        }
      }
      for (const name of matched) {
        this.enqueueDebounced(name, { kind: 'onTypeInsert' });
      }
      return;
    }

    // state-change: match `onNodeState` triggers whose typeNames overlap the
    // event's type AND whose target state equals the event's state.
    if (event.kind === 'state-change') {
      if (!event.state) return;
      const matched = new Set<string>();
      for (const job of this.jobs.values()) {
        for (const trig of job.triggers) {
          if (trig.kind !== 'onNodeState') continue;
          if (trig.state !== event.state) continue;
          if (trig.typeNames.some(t => event.typeNames.includes(t))) {
            matched.add(job.name);
            break;
          }
        }
      }
      for (const name of matched) {
        this.enqueueDebounced(name, { kind: 'onNodeState' });
      }
    }
  }

  private startupCatchup(): void {
    for (const job of this.jobs.values()) {
      const st = this.state.get(job.name)!;
      if (!st.cursorTypes || st.cursorTypes.length === 0) continue;
      const row = this.db.getJob(job.name);
      if (!row?.enabled) continue;

      const cursor = readCatchupCursor(this.db, job.name);
      const fresh = this.db.findNodesOfTypeSince(st.cursorTypes, cursor);
      if (fresh.length === 0) {
        // Move cursor forward to today so we don't replay history on first boot.
        if (cursor === 0) writeCatchupCursor(this.db, job.name, this.db.maxNodeRowid());
        continue;
      }
      this.log(`[${job.name}] startup catch-up: ${fresh.length} unseen nodes since rowid ${cursor}`);
      this.enqueue(job.name, { kind: 'startup' });
    }
  }

  private pollTriggerPending(): void {
    for (const job of this.jobs.values()) {
      const row = this.db.getJob(job.name);
      if (!row?.triggerPending) continue;
      this.db.clearJobTriggerPending(job.name);
      this.enqueue(job.name, { kind: 'manual' });
    }
  }

  private pollConfig(): void {
    try {
      const cfg = loadConfig();
      this.config = cfg;
      const projectJobs = cfg.projects[this.project.name]?.jobs ?? {};
      for (const job of this.jobs.values()) {
        const desired = projectJobs[job.name]?.enabled;
        if (desired === undefined) continue;
        const row = this.db.getJob(job.name);
        if (!row || row.enabled === desired) continue;
        this.db.setJobEnabled(job.name, desired);
        this.log(`[${job.name}] enabled=${desired} (config change)`);
        this.installTimers(job);
      }
    } catch (err) {
      this.log(`config poll failed: ${(err as Error).message}`);
    }
  }

  private enqueueDebounced(name: string, trigger: PendingTrigger): void {
    const st = this.state.get(name);
    if (!st) return;
    if (st.debounceTimer) clearTimeout(st.debounceTimer);
    st.debounceTimer = setTimeout(() => {
      st.debounceTimer = null;
      this.enqueue(name, trigger);
    }, DEBOUNCE_MS);
  }

  private enqueue(name: string, trigger: PendingTrigger): void {
    const job = this.jobs.get(name);
    if (!job) return;
    const row = this.db.getJob(name);
    if (!row?.enabled) return;

    const st = this.state.get(name)!;
    // Coalesce: a job can be "pending again" at most once.
    if (this.running) {
      st.pending = trigger;
      return;
    }
    st.pending = null;
    void this.execute(job, trigger.kind);
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  private async execute(job: Job, triggerKind: PendingTrigger['kind']): Promise<void> {
    if (this.running) {
      // Defensive: enqueue again rather than recurse.
      this.state.get(job.name)!.pending = { kind: triggerKind };
      return;
    }
    this.running = true;
    this.currentJob = job.name;
    const runId = this.db.startJobRun(job.name, triggerKind);
    const ctx: JobContext = {
      db: this.db,
      dbPath: this.dbPath,
      project: this.project,
      config: this.config,
      parameters: resolveJobParameters(this.config, this.project.name, job.name),
      signal: this.abortController.signal,
      log: (msg) => this.log(`[${job.name}] ${msg}`),
    };
    this.log(`[${job.name}] start (${triggerKind})`);

    // For onTypeInsert jobs, snapshot the cursor BEFORE running so newly-inserted
    // nodes that arrive mid-run are caught on the next pass.
    const cursorBefore = this.state.get(job.name)!.cursorTypes ? this.db.maxNodeRowid() : null;

    try {
      const result = await withRunLog(this.project.name, runId, () => job.run(ctx));
      this.db.endJobRun(runId, 'ok', { message: result.message, metrics: result.metrics });
      this.log(`[${job.name}] ok${result.message ? ` — ${result.message}` : ''}`);
      if (cursorBefore !== null) writeCatchupCursor(this.db, job.name, cursorBefore);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.db.endJobRun(runId, 'error', { error: message });
      this.log(`[${job.name}] error: ${message}`);
    } finally {
      this.running = false;
      this.currentJob = null;
      // If something was enqueued during the run, drain it.
      const next = this.findNextPending();
      if (next) {
        const { name, trigger } = next;
        const job = this.jobs.get(name)!;
        setImmediate(() => void this.execute(job, trigger.kind));
      }
    }
  }

  private findNextPending(): { name: string; trigger: PendingTrigger } | null {
    for (const [name, st] of this.state) {
      if (st.pending) {
        const trigger = st.pending;
        st.pending = null;
        return { name, trigger };
      }
    }
    return null;
  }

  private log(msg: string): void {
    // Match the existing daemon's bracketed prefix so logs stay greppable.
    console.log(`[scheduler] ${msg}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectInsertTypes(triggers: JobTrigger[]): string[] | null {
  const out = new Set<string>();
  for (const t of triggers) {
    if (t.kind === 'onTypeInsert') for (const n of t.typeNames) out.add(n);
  }
  return out.size === 0 ? null : Array.from(out);
}

interface CatchupState {
  cursor?: number;
  [k: string]: unknown;
}

function readCatchupCursor(db: Db, jobName: string): number {
  const state = db.getJobState<CatchupState>(jobName);
  return state?.cursor ?? 0;
}

function writeCatchupCursor(db: Db, jobName: string, cursor: number): void {
  const state = (db.getJobState<CatchupState>(jobName)) ?? {};
  state.cursor = cursor;
  db.setJobState(jobName, state);
}
