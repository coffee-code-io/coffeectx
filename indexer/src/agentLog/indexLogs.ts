import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@coffeectx/core';
import { readLogFile, deduplicateMessages } from './reader.js';
import { classifyMessages, extractSessions } from './classifier.js';
import { enrichEvents } from './enricher.js';
import type { EnrichedEvent } from './enricher.js';
import type { InsertEntry } from '@coffeectx/core';
import {
  type FileHashStore,
  hasLogFileChanged,
  markLogFileIndexed,
  saveFileHashes,
} from '../fileHashes.js';

export interface IndexLogsOptions {
  /** Only index sessions whose startTime is at or after this date. */
  newerThan?: Date;
  /** If provided, skip files whose mtime/size hasn't changed; updated after indexing. */
  hashes?: FileHashStore;
}

export interface IndexLogsResult {
  files: number;
  skipped: number;
  sessions: number;
  events: number;
  inserted: number;
  errors: Array<{ file: string; error: string; stack?: string }>;
}

/**
 * Index one or more Claude Code JSONL log files into the knowledge graph.
 * @param db     Open Db instance (must have AgentLog types synced).
 * @param paths  Array of absolute file or directory paths.
 */
export async function indexLogs(db: Db, paths: string[], options: IndexLogsOptions = {}): Promise<IndexLogsResult> {
  const { newerThan, hashes } = options;
  const result: IndexLogsResult = { files: 0, skipped: 0, sessions: 0, events: 0, inserted: 0, errors: [] };

  const logFiles = resolveLogFiles(paths);
  result.files = logFiles.length;

  // Preload all existing UUIDs and sessionIds once to avoid per-event DB queries.
  const existingUuids = loadExistingUuids(db);
  const existingSessionIds = loadExistingSessionIds(db);

  for (const filePath of logFiles) {
    if (hashes && !hasLogFileChanged(filePath, hashes)) {
      result.skipped++;
      continue;
    }
    try {
      await indexSingleFile(db, filePath, result, existingUuids, existingSessionIds, newerThan);
      if (hashes) {
        markLogFileIndexed(filePath, hashes);
        saveFileHashes(hashes);
      }
    } catch (err) {
      result.errors.push({ file: filePath, error: (err as Error).message, stack: (err as Error).stack });
    }
  }

  return result;
}

async function indexSingleFile(db: Db, filePath: string, result: IndexLogsResult, existingUuids: Set<string>, existingSessionIds: Set<string>, newerThan?: Date): Promise<void> {
  // 1. Read + deduplicate
  const raw = await readLogFile(filePath);
  const messages = deduplicateMessages(raw);

  // 2. Extract session metadata (all sessions — metadata is cheap to store)
  const sessions = extractSessions(messages);
  result.sessions += sessions.size;

  // 3. Classify → only important events, filtered by individual message timestamp
  const allEvents = classifyMessages(messages);
  const events = newerThan
    ? allEvents.filter(e => new Date(e.timestamp) >= newerThan)
    : allEvents;

  // 4. Enrich with DB links (best-effort)
  const enriched = await enrichEvents(events, db);
  result.events += enriched.length;

  if (enriched.length === 0 && sessions.size === 0) return;

  // 5. Build InsertEntry batches
  const entries: InsertEntry[] = [];

  // Session entries — skip if an AgentSession with this sessionId already exists
  for (const [sessionId, meta] of sessions) {
    if (existingSessionIds.has(sessionId)) continue;
    entries.push({
      type: 'AgentSession',
      data: {
        sessionId,
        projectPath: meta.cwd ?? '',
        startTime: meta.startTime,
        model: meta.model ?? '',
      },
    });
  }

  // Event entries — skip if a node with the same uuid already exists.
  // Note: AgentMessage and AgentSummary share their parent assistant message's
  // uuid, so a turn that emits both kinds will only land one entry — that's
  // by design: each assistant turn is either narration (work-in-progress) or
  // summary (work-done), never both at once.
  for (const event of enriched) {
    if (existingUuids.has(event.uuid)) continue;
    const entry = eventToInsertEntry(event);
    if (entry) {
      entries.push(entry);
      existingUuids.add(event.uuid);
    }
  }

  if (entries.length === 0) return;

  // 6. Insert in batches of 200 (avoid huge single transactions)
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const insertResult = await db.insertEntries(batch);
    result.inserted += insertResult.ids.filter(id => id !== null).length;
    for (const err of insertResult.errors) {
        const errorMsg = `Batch ${i / BATCH + 1}, entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`;
        console.error(`[indexLogs] ${errorMsg}`);
    }
  }
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

/** Collect .jsonl file paths from a mix of file and directory paths. */
function resolveLogFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (stat.isFile()) {
      if (p.endsWith('.jsonl')) files.push(p);
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry.endsWith('.jsonl')) files.push(join(p, entry));
      }
    }
  }
  return files;
}
