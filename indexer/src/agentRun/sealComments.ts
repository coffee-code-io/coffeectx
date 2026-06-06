/**
 * Post-span hook: seal the LSP-symbol comments the indexer agent just
 * wrote on this span, and propagate them forward through the timeline.
 *
 * The agent's contract is intentionally tiny — it just calls
 * `upsert_entries` with `{ $id, comment }`. The DB layer accepts that
 * patch because Lsp* types now have a `commented` state AFTER `linked`
 * (so `linked` is no longer terminal). What it does NOT do automatically:
 *
 *   - advance the touched version to `commented` (no `$state` in the
 *     agent's patch — the prompt deliberately forbids it),
 *   - copy the freshly-written comment to newer versions on the same
 *     timeline (the LSP indexer doesn't carry `comment` forward when
 *     bumping for source changes, so the head row would silently lose
 *     the comment otherwise).
 *
 * That bookkeeping lives here, runs once per span turn (oldest-first), and
 * is pure DB I/O — no agent involvement.
 *
 * Why we always supply `state:` on the propagation patch: the InsertEntry
 * immutability check rejects patches when `currentEffective === finalState
 * && entry.state == null`. Passing `entry.state` explicitly (even when
 * it equals the current state) bypasses that check, so we can write to
 * `linked`/`final`/`new` rows without bumping them out of their state.
 */

import type { Db, DeepNode } from '@coffeectx/core';

export function sealAndPropagateComments(db: Db, spanId: string): void {
  const span = db.loadNodeDeep(spanId, 2);
  if (span.kind !== 'map') return;
  const touchedIds = extractIds(span.entries['touchedSymbols']);

  for (const id of touchedIds) {
    const typeName = db.getNodeTypeName(id);
    if (!typeName || !typeName.startsWith('Lsp')) continue;

    let node: DeepNode;
    try { node = db.loadNodeDeep(id, 1); }
    catch { continue; }
    if (node.kind !== 'map') continue;

    // Already sealed — a prior indexer run finalised this version. The
    // forward propagation already ran at that point, so there is nothing
    // to do today.
    if (node.state === 'commented') continue;

    const comment = atomMeaningText(node.entries['comment']);
    if (!comment) continue; // agent declined to comment this symbol

    const timelineId = node.timelineId ?? id;
    const touchedVersion = node.version ?? 1;

    // 1. Seal the touched version. The agent already wrote the comment, so
    //    `data.comment` here is a no-op for that field — we're only here
    //    for the state advance. Other fields are preserved by the patch
    //    path's "only-write-supplied-keys" semantics.
    try {
      db.insertEntries([{
        id,
        type: typeName,
        data: { comment },
        state: 'commented',
      }]);
    } catch (err) {
      console.warn(`[sealComments] seal failed for ${id} (${typeName}): ${(err as Error).message}`);
      continue;
    }

    // 2. Propagate forward. Walk every later version on the same timeline
    //    (`version > touchedVersion`), skip tombstones (no body) and rows
    //    already at `commented` (their comment is sealed by definition).
    let versions;
    try { versions = db.listTimelineVersions(timelineId); }
    catch { continue; }

    for (const v of versions) {
      if (v.version <= touchedVersion) continue;
      if (v.tombstone) continue;
      if (v.state === 'commented') continue;
      try {
        db.insertEntries([{
          id: v.id,
          type: typeName,
          data: { comment },
          // Preserve whichever state the later version was in (new / final /
          // linked). Supplying `state` explicitly is what bypasses the
          // immutability check; the value just needs to be valid.
          state: v.state ?? 'linked',
        }]);
      } catch (err) {
        console.warn(
          `[sealComments] propagate failed for ${v.id} (${typeName} v${v.version}): ${(err as Error).message}`,
        );
        // Keep walking — partial propagation is better than no propagation.
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract every `$id` from a DeepNode list of refs / maps. Mirrors
 *  `listOfRefs` in spanMd.ts but is duplicated here to keep this module
 *  self-contained. */
function extractIds(node: DeepNode | undefined): string[] {
  if (!node || node.kind !== 'list') return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (item.kind === 'ref') out.push(item.id);
    else if (item.kind === 'map' && item.id) out.push(item.id);
  }
  return out;
}

function atomMeaningText(node: DeepNode | undefined): string | null {
  if (!node || node.kind !== 'atom') return null;
  if (node.atom.kind !== 'meaning') return null;
  const t = node.atom.value.text;
  return t.length > 0 ? t : null;
}
