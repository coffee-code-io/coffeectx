/**
 * Minimal LSP client over a spawned stdio process.
 *
 * Uses string method names to avoid ProtocolRequestType / NotificationType
 * private-property conflicts between vscode-jsonrpc and vscode-languageserver-protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import { type DocumentSymbol, type SymbolInformation, SymbolKind } from 'vscode-languageserver-protocol';

export { DocumentSymbol, SymbolInformation, SymbolKind };

export class LspClient {
  private proc: ChildProcess;
  private conn: MessageConnection;

  private constructor(proc: ChildProcess, conn: MessageConnection) {
    this.proc = proc;
    this.conn = conn;
  }

  /** Spawn a language server and complete the LSP handshake. */
  static async start(command: string, args: string[], rootPath: string): Promise<LspClient> {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout!),
      new StreamMessageWriter(proc.stdin!),
    );
    conn.listen();

    const rootUri = pathToFileURL(rootPath).href;

    await conn.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
        workspace: {},
      },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    });

    conn.sendNotification('initialized', {});

    return new LspClient(proc, conn);
  }

  /**
   * Request hierarchical document symbols for a file on disk.
   * Returns DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat),
   * depending on what the server supports.
   */
  async documentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const uri = pathToFileURL(filePath).href;
    const text = readFileSync(filePath, 'utf-8');
    const ext = filePath.split('.').pop() ?? '';
    const languageId = extToLanguageId(ext);

    this.conn.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });

    // Small delay to let the server process the open notification before querying.
    await sleep(50);

    const result = await this.conn.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    return (result as DocumentSymbol[] | SymbolInformation[] | null) ?? [];
  }

  async shutdown(): Promise<void> {
    try {
      await this.conn.sendRequest('shutdown', null);
    } catch { /* server may have already closed */ }

    // Suppress "write after stream destroyed" errors — the server closes
    // its stdin/stdout in response to the exit notification.
    this.proc.stdin?.on('error', () => {});
    this.proc.stdout?.on('error', () => {});

    try {
      this.conn.sendNotification('exit', undefined);
    } catch { /* ignore */ }

    this.conn.dispose();

    // Wait for the process to exit naturally; force-kill after 2 s.
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.proc.kill(); resolve(); }, 2000);
      this.proc.on('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extToLanguageId(ext: string): string {
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'cpp': case 'cc': case 'cxx': return 'cpp';
    case 'c': return 'c';
    case 'rb': return 'ruby';
    default: return ext;
  }
}
