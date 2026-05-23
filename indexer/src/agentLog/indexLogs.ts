/**
 * Provider-agnostic agent-session indexer.
 *
 * Takes an `AgentLogProvider` that hands us normalised sessions + messages
 * (see [provider.ts](provider.ts)), then runs the shared classify → enrich →
 * upsert pipeline. This pipeline used to be hard-wired to Claude Code's JSONL
 * format; the abstraction lets Codex CLI and pi.dev sessions land as the same
 * AgentSession / UserInput / FileOperation / ShellExecution / AgentQuestion /
 * AgentMessage / AgentSummary node types without code duplication.
 */

import type { Db, InsertEntry } from '@coffeectx/core';
import { classifyMessages } from './classifier.js';
import { enrichEvents } from './enricher.js';
import type { EnrichedEvent } from './enricher.js';
import type { AgentLogProvider, ProviderScanOptions } from './provider.js';
import { Progress } from '../jobs/progress.js';
import { computeFileContext } from './sessionContext.js';

export interface IndexLogsOptions extends ProviderScanOptions {
  /**
   * Project's repo root. When supplied, every file path written to
   * `event_file_context` is also recorded in its repo-relative form (when it
   * lives under repoPath) so the enricher's `lspSymbolsByFilePaths` lookup
   * matches LSP nodes regardless of whether the source provider used an
   * absolute or relative path.
   */
  repoPath?: string;
}

export interface IndexLogsResult {
  files: number;       // kept for back-compat with run-log messages
  skipped: number;     // kept for back-compat
  sessions: number;
  events: number;
  inserted: number;
  errors: Array<{ file: string; error: string; stack?: string }>;
}

/**
 * Run the agent-log indexer for one provider against an open DB.
 * Returns a small summary suitable for the scheduler's run-log line.
 */
export async function indexAgentSessions(
  db: Db,
  provider: AgentLogProvider,
  options: IndexLogsOptions = {},
): Promise<IndexLogsResult> {
  const result: IndexLogsResult = {
    files: 0, skipped: 0, sessions: 0, events: 0, inserted: 0, errors: [],
  };

  let scanned;
  try {
    scanned = await provider.scan(options);
  } catch (err) {
    result.errors.push({
      file: provider.name,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return result;
  }

  result.sessions = scanned.sessions.size;

  // Classify + filter by newerThan (per-event, not per-session — late events in
  // an old session still get indexed).
  const allEvents = classifyMessages(scanned.messages);
  const events = options.newerThan
    ? allEvents.filter(e => new Date(e.timestamp) >= options.newerThan!)
    : allEvents;
  console.log(
    `[${provider.name}] classified ${events.length} events ` +
    `from ${scanned.messages.length} messages (${scanned.sessions.size} sessions)`,
  );

  // Compute per-event file context (which file each text event is "about" in
  // its session, based on nearby Edit/Write tool calls). Drives the enricher's
  // filter and gets persisted to event_file_context after insert.
  //
  // The raw paths come from FileOperation.path which is often absolute (Claude
  // and Codex both use absolute paths). LSP symbols are indexed by repo-relative
  // path. So we expand each context to include BOTH forms when the path lives
  // under the project's repoPath — that way the enricher's
  // `lspSymbolsByFilePaths` lookup matches either side.
  const rawContext = computeFileContext(events);
  const repoPrefix = options.repoPath
    ? (options.repoPath.endsWith('/') ? options.repoPath : `${options.repoPath}/`)
    : null;
  const fileContextByUuid = new Map<string, string[]>();
  for (const [uuid, paths] of rawContext) {
    const expanded = new Set<string>();
    for (const p of paths) {
      expanded.add(p);
      if (repoPrefix && p.startsWith(repoPrefix)) expanded.add(p.slice(repoPrefix.length));
    }
    fileContextByUuid.set(uuid, [...expanded]);
  }
  console.log(
    `[${provider.name}] file-context: ${fileContextByUuid.size} text events scoped to a file ` +
    `(${events.length - fileContextByUuid.size} unscoped — will get no relatedSymbols)`,
  );

  // Enrichment is the slow phase — does one findNamedParent per identifier per
  // event. Driving the Progress reporter from inside the loop is the only way
  // to tell whether the job is running or hung.
  const enrichProgress = new Progress(`${provider.name}:enrich`, events.length);
  const enriched = await enrichEvents(events, db, {
    onTick: (i) => enrichProgress.tick(i),
    fileContextByUuid,
  });
  enrichProgress.done();
  result.events = enriched.length;

  if (enriched.length === 0 && scanned.sessions.size === 0) return result;

  // Preload existing UUIDs / sessionIds once.
  const existingUuids = loadExistingUuids(db);
  const existingSessionIds = loadExistingSessionIds(db);

  const entries: InsertEntry[] = [];
  // Track the source-uuid of each event entry by its position in `entries` so
  // we can map the inserted node id back to its file-context after the insert.
  const eventUuidByEntryIdx: Array<string | null> = [];

  for (const meta of scanned.sessions.values()) {
    if (existingSessionIds.has(meta.sessionId)) continue;
    entries.push({
      type: 'AgentSession',
      data: {
        sessionId: meta.sessionId,
        projectPath: meta.cwd ?? '',
        startTime: meta.startTime,
        model: meta.model ?? '',
        provider: meta.provider,
      },
    });
    eventUuidByEntryIdx.push(null);
    existingSessionIds.add(meta.sessionId);
  }

  for (const event of enriched) {
    if (existingUuids.has(event.uuid)) continue;
    const entry = eventToInsertEntry(event);
    if (entry) {
      entries.push(entry);
      eventUuidByEntryIdx.push(event.uuid);
      existingUuids.add(event.uuid);
    }
  }

  if (entries.length === 0) {
    console.log(`[${provider.name}] no new entries to insert`);
    return result;
  }

  // Insert in batches of 200 to keep transactions bounded.
  const BATCH = 200;
  const totalBatches = Math.ceil(entries.length / BATCH);
  const insertProgress = new Progress(`${provider.name}:insert`, entries.length);
  const contextRows: Array<{ eventId: string; filePath: string }> = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    insertProgress.tick(i, `batch ${i / BATCH + 1}/${totalBatches}`);
    const insertResult = await db.insertEntries(batch);
    result.inserted += insertResult.ids.filter(id => id !== null).length;
    for (const err of insertResult.errors) {
      const errorMsg = `Batch ${i / BATCH + 1}, entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`;
      console.error(`[${provider.name}] ${errorMsg}`);
    }
    // Map inserted node ids back to their source event uuids so we can write
    // the file-context rows once the node ids are known. Each path is also
    // recorded in its repo-relative form (when applicable) so the enricher's
    // file_path lookup matches LSP nodes' relative paths.
    const repoPrefix = options.repoPath
      ? (options.repoPath.endsWith('/') ? options.repoPath : `${options.repoPath}/`)
      : null;
    for (let k = 0; k < insertResult.ids.length; k++) {
      const nodeId = insertResult.ids[k];
      const uuid = eventUuidByEntryIdx[i + k];
      if (!nodeId || !uuid) continue;
      const paths = fileContextByUuid.get(uuid);
      if (!paths) continue;
      for (const p of paths) {
        contextRows.push({ eventId: nodeId, filePath: p });
        if (repoPrefix && p.startsWith(repoPrefix)) {
          contextRows.push({ eventId: nodeId, filePath: p.slice(repoPrefix.length) });
        }
      }
    }
  }
  insertProgress.done(`${result.inserted} inserted`);

  if (contextRows.length > 0) {
    db.writeEventFileContext(contextRows);
    console.log(`[${provider.name}] wrote ${contextRows.length} event_file_context rows`);
  }

  return result;
}

function eventToInsertEntry(event: EnrichedEvent): InsertEntry | null {
  switch (event.kind) {
    case 'user_input':
      return {
        type: 'UserInput',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          text: event.text ?? '',
          relatedFiles: [],
          relatedSymbols: event.linkedRefs,
        },
      };

    case 'file_create':
    case 'file_edit':
      return {
        type: 'FileOperation',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          operation: event.kind === 'file_create' ? 'create' : 'edit',
          path: event.path ?? '',
          preview: event.preview ?? '',
          touchedSymbols: [],
        },
      };

    case 'shell_exec':
      return {
        type: 'ShellExecution',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          command: event.command ?? '',
          description: event.description ?? '',
        },
      };

    case 'agent_question':
      return {
        type: 'AgentQuestion',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          question: event.question ?? '',
          relatedSymbols: event.linkedRefs,
        },
      };

    case 'agent_message':
      return {
        type: 'AgentMessage',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          text: event.text ?? '',
          relatedSymbols: event.linkedRefs,
        },
      };

    case 'agent_summary':
      return {
        type: 'AgentSummary',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          timestamp: event.timestamp,
          text: event.text ?? '',
          relatedSymbols: event.linkedRefs,
        },
      };

    default:
      return null;
  }
}

const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage', 'AgentSummary'];

/** Load all existing event UUIDs from the DB in one pass. */
function loadExistingUuids(db: Db): Set<string> {
  const uuids = new Set<string>();
  for (const id of db.queryByNamedType(EVENT_TYPES)) {
    const fieldId = db.getMapFieldId(id, 'uuid');
    if (!fieldId) continue;
    const node = db.loadNode(fieldId);
    if (node.kind === 'atom' && node.atom.kind === 'symbol') uuids.add(node.atom.value);
  }
  return uuids;
}

/** Load all existing AgentSession sessionIds from the DB in one pass. */
function loadExistingSessionIds(db: Db): Set<string> {
  const ids = new Set<string>();
  for (const mapId of db.queryByNamedType(['AgentSession'])) {
    const fieldId = db.getMapFieldId(mapId, 'sessionId');
    if (!fieldId) continue;
    const node = db.loadNode(fieldId);
    if (node.kind === 'atom' && node.atom.kind === 'symbol') ids.add(node.atom.value);
  }
  return ids;
}
