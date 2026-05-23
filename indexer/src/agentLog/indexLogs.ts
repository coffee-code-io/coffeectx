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

export interface IndexLogsOptions extends ProviderScanOptions {}

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

  const enriched = await enrichEvents(events, db);
  result.events = enriched.length;

  if (enriched.length === 0 && scanned.sessions.size === 0) return result;

  // Preload existing UUIDs / sessionIds once.
  const existingUuids = loadExistingUuids(db);
  const existingSessionIds = loadExistingSessionIds(db);

  const entries: InsertEntry[] = [];

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
    existingSessionIds.add(meta.sessionId);
  }

  for (const event of enriched) {
    if (existingUuids.has(event.uuid)) continue;
    const entry = eventToInsertEntry(event);
    if (entry) {
      entries.push(entry);
      existingUuids.add(event.uuid);
    }
  }

  if (entries.length === 0) return result;

  // Insert in batches of 200 to keep transactions bounded.
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const insertResult = await db.insertEntries(batch);
    result.inserted += insertResult.ids.filter(id => id !== null).length;
    for (const err of insertResult.errors) {
      const errorMsg = `Batch ${i / BATCH + 1}, entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`;
      console.error(`[indexAgentSessions:${provider.name}] ${errorMsg}`);
    }
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
