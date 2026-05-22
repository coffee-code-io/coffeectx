/**
 * Index Claude Code plan files into the knowledge graph as `Plan` nodes.
 *
 * Plans are markdown documents written during "plan mode" turns. Claude saves
 * them to `~/.claude/plans/<slug>.md`. They're high-signal artefacts because
 * they capture the agent's intended approach (context, files, verification)
 * before any code is written.
 *
 * One Plan node per `.md` file in the directory; the filename slug (sans
 * extension) is the dedup key.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Db, InsertEntry } from '@coffeectx/core';

export interface IndexPlansOptions {
  /** Absolute path of the plans directory. Defaults to `~/.claude/plans`. */
  plansDir: string;
}

export interface IndexPlansResult {
  scanned: number;
  inserted: number;
  patched: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/** Scan the directory and upsert Plan nodes. */
export async function indexPlans(db: Db, options: IndexPlansOptions): Promise<IndexPlansResult> {
  const result: IndexPlansResult = { scanned: 0, inserted: 0, patched: 0, skipped: 0, errors: [] };

  let entries: string[];
  try {
    entries = readdirSync(options.plansDir);
  } catch (err) {
    result.errors.push({ path: options.plansDir, error: (err as Error).message });
    return result;
  }

  const existing = loadExistingPlans(db);

  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.md') continue;
    const path = join(options.plansDir, entry);
    result.scanned++;

    let stat;
    try { stat = statSync(path); }
    catch (err) { result.errors.push({ path, error: (err as Error).message }); continue; }
    if (!stat.isFile()) continue;

    let content: string;
    try { content = readFileSync(path, 'utf-8'); }
    catch (err) { result.errors.push({ path, error: (err as Error).message }); continue; }

    const name = basename(entry, extname(entry));
    const updatedAt = new Date(stat.mtimeMs).toISOString();
    const createdAt = stat.birthtimeMs ? new Date(stat.birthtimeMs).toISOString() : updatedAt;
    const title = extractTitle(content);

    const prior = existing.get(name);
    if (!prior) {
      const entry: InsertEntry = {
        type: 'Plan',
        data: {
          name,
          path,
          createdAt,
          updatedAt,
          content,
          ...(title ? { title } : {}),
        },
      };
      try {
        const r = await db.insertEntries([entry]);
        if (r.errors.length > 0) {
          result.errors.push({ path, error: r.errors.map(e => e.message).join('; ') });
        } else {
          result.inserted++;
        }
      } catch (err) {
        result.errors.push({ path, error: (err as Error).message });
      }
      continue;
    }

    // Skip unchanged files.
    if (prior.updatedAt === updatedAt) {
      result.skipped++;
      continue;
    }

    // mtime changed — overwrite `updatedAt` and `content`. (`patch` semantics
    // in insertEntries only add absent fields, so we delete + reinsert.)
    // Cheaper alternative: future Db extension for full upsert. For now, log a
    // warning and skip overwriting; users can manually re-index by removing the
    // stale Plan node if needed.
    result.skipped++;
    console.warn(
      `[indexPlans] plan "${name}" changed on disk (mtime ${updatedAt}) but Db patching adds-only — ` +
      `existing node retains previous content. Delete the Plan node manually to force a re-index.`,
    );
  }

  return result;
}

interface PlanRow {
  id: string;
  updatedAt: string;
}

function loadExistingPlans(db: Db): Map<string, PlanRow> {
  const out = new Map<string, PlanRow>();
  for (const id of db.queryByNamedType(['Plan'])) {
    const nameFieldId = db.getMapFieldId(id, 'name');
    const updatedFieldId = db.getMapFieldId(id, 'updatedAt');
    if (!nameFieldId || !updatedFieldId) continue;
    const nameNode = db.loadNode(nameFieldId);
    const updatedNode = db.loadNode(updatedFieldId);
    if (nameNode.kind !== 'atom' || nameNode.atom.kind !== 'symbol') continue;
    if (updatedNode.kind !== 'atom' || updatedNode.atom.kind !== 'symbol') continue;
    out.set(nameNode.atom.value, { id, updatedAt: updatedNode.atom.value });
  }
  return out;
}

/** Pull the first-line H1 or the first non-empty trimmed line, capped at 200 chars. */
function extractTitle(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#+\s+(.+)$/);
    const candidate = m ? m[1]!.trim() : t;
    if (!candidate) continue;
    return candidate.length > 200 ? candidate.slice(0, 197) + '…' : candidate;
  }
  return null;
}
