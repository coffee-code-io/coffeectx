import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { COFFEECODE_DIR } from './config.js';

const LOG_PATH = join(COFFEECODE_DIR, 'coffeectx.log');

export function log(message: string): void {
  try {
    if (!existsSync(COFFEECODE_DIR)) mkdirSync(COFFEECODE_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* ignore */ }
}
