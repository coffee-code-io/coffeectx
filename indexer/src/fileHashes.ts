/**
 * File/repo fingerprint store for change-detection across indexer runs.
 *
 * Log files: keyed by absolute path, fingerprinted by mtime + size (fast stat).
 * LSP repos: keyed by "lsp:<repoPath>", fingerprinted by SHA-256 of sorted
 *            "relPath:mtime:size" manifest (detects any source file change).
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const HASHES_PATH = join(homedir(), '.coffeecode', 'file-hashes.json');

export interface StatFingerprint {
  mtime: number;
  size: number;
}

export interface HashFingerprint {
  hash: string;
}

export type FileFingerprint = StatFingerprint | HashFingerprint;

export type FileHashStore = Record<string, FileFingerprint>;

export function loadFileHashes(): FileHashStore {
  try {
    return JSON.parse(readFileSync(HASHES_PATH, 'utf-8')) as FileHashStore;
  } catch {
    return {};
  }
}

export function saveFileHashes(hashes: FileHashStore): void {
  try {
    writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2));
  } catch (err) {
    console.warn(`[fileHashes] Failed to save: ${(err as Error).message}`);
  }
}

// ── Log file helpers (stat-based) ─────────────────────────────────────────────

function statFingerprint(filePath: string): StatFingerprint | null {
  try {
    const s = statSync(filePath);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Returns true if the file's mtime/size differs from the stored fingerprint. */
export function hasLogFileChanged(filePath: string, hashes: FileHashStore): boolean {
  const stored = hashes[filePath] as StatFingerprint | undefined;
  if (!stored || stored.mtime === undefined) return true;
  const current = statFingerprint(filePath);
  if (!current) return true;
  return current.mtime !== stored.mtime || current.size !== stored.size;
}

/** Record the current mtime/size for a log file. Call after successful indexing. */
export function markLogFileIndexed(filePath: string, hashes: FileHashStore): void {
  const fp = statFingerprint(filePath);
  if (fp) hashes[filePath] = fp;
}

// ── LSP repo helpers (manifest hash) ─────────────────────────────────────────

/** Compute a SHA-256 hash of the sorted "relPath:mtime:size" manifest for a file list. */
export function computeRepoManifestHash(repoPath: string, sourceFiles: string[]): string {
  const entries = sourceFiles
    .map(f => {
      try {
        const s = statSync(f);
        return `${relative(repoPath, f)}:${s.mtimeMs}:${s.size}`;
      } catch {
        return null;
      }
    })
    .filter((e): e is string => e !== null)
    .sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 32);
}

const lspKey = (repoPath: string) => `lsp:${repoPath}`;

/** Returns true if any source file in the repo has changed since last LSP index. */
export function hasRepoChanged(repoPath: string, hashes: FileHashStore, sourceFiles: string[]): boolean {
  const stored = hashes[lspKey(repoPath)] as HashFingerprint | undefined;
  if (!stored?.hash) return true;
  return computeRepoManifestHash(repoPath, sourceFiles) !== stored.hash;
}

/** Record the current manifest hash for a repo. Call after successful LSP indexing. */
export function markRepoIndexed(repoPath: string, hashes: FileHashStore, sourceFiles: string[]): void {
  hashes[lspKey(repoPath)] = { hash: computeRepoManifestHash(repoPath, sourceFiles) };
}
