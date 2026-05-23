/**
 * Throttled progress reporter for long-running indexer jobs.
 *
 * Calls to `tick()` print at most one stdout line per `intervalMs` (default
 * 1s), with the first and last calls always forced through. The job-run log
 * captures these lines automatically via `withRunLog`'s stdout wrap, so
 * progress is both visible in the terminal and queryable from the runs UI.
 *
 * Usage:
 *   const p = new Progress('lsp', total, { intervalMs: 1000 });
 *   for (const [i, item] of items.entries()) {
 *     p.tick(i, item.path);
 *     await doWork(item);
 *   }
 *   p.done();
 */

export interface ProgressOptions {
  intervalMs?: number;
}

export class Progress {
  private readonly intervalMs: number;
  private readonly t0: number;
  private lastLog = 0;

  constructor(
    private readonly label: string,
    private readonly total: number,
    opts: ProgressOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.t0 = Date.now();
    console.log(`[${this.label}] start: 0/${this.total}`);
  }

  /** Print progress for the given 0-based index. Throttled to once per interval. */
  tick(i: number, detail?: string): void {
    const now = Date.now();
    if (i !== 0 && now - this.lastLog < this.intervalMs) return;
    this.lastLog = now;
    this.emit(i, detail);
  }

  /** Force the final progress line. Always emits. */
  done(detail?: string): void {
    this.emit(this.total, detail);
    const elapsed = ((Date.now() - this.t0) / 1000).toFixed(1);
    console.log(`[${this.label}] done in ${elapsed}s`);
  }

  private emit(i: number, detail?: string): void {
    const pct = this.total > 0 ? Math.floor((i / this.total) * 100) : 100;
    const elapsed = ((Date.now() - this.t0) / 1000).toFixed(1);
    const tail = detail ? ` — ${detail}` : '';
    console.log(`[${this.label}] ${i}/${this.total} (${pct}%) t=${elapsed}s${tail}`);
  }
}
