import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.coffeecode');
const LOG_PATH = join(LOG_DIR, 'retrival-mcp.log');

export function log(message: string): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* ignore */ }
}
