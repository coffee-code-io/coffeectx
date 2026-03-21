/**
 * Readline-based prompt utilities for the interactive setup wizard.
 * Uses a single shared readline interface across all prompt calls.
 */

import { createInterface } from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';

let rl: ReadlineInterface | null = null;

function getRl(): ReadlineInterface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

/**
 * Ask a free-form question.
 * Returns the trimmed answer, or `defaultVal` if the user pressed Enter with no input.
 */
export function ask(question: string, defaultVal?: string): Promise<string> {
  const hint = defaultVal !== undefined ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    getRl().question(`${question}${hint}: `, answer => {
      const trimmed = answer.trim();
      resolve(trimmed === '' && defaultVal !== undefined ? defaultVal : trimmed);
    });
  });
}

/**
 * Ask a yes/no confirmation question.
 * Shows [Y/n] when defaultVal is true, [y/N] when false (or undefined → false).
 */
export function confirm(question: string, defaultVal = false): Promise<boolean> {
  const hint = defaultVal ? '[Y/n]' : '[y/N]';
  return new Promise(resolve => {
    getRl().question(`${question} ${hint}: `, answer => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === '') {
        resolve(defaultVal);
      } else {
        resolve(trimmed === 'y' || trimmed === 'yes');
      }
    });
  });
}

/**
 * Present a numbered list and ask the user to pick one.
 * Returns the selected option string.
 */
export async function choose(
  question: string,
  options: string[],
  defaultIdx = 0,
): Promise<string> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? ' (default)' : '';
    console.log(`  ${i + 1}) ${options[i]}${marker}`);
  }

  while (true) {
    const answer = await ask(`Enter number`, String(defaultIdx + 1));
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) {
      return options[num - 1]!;
    }
    console.log(`Please enter a number between 1 and ${options.length}.`);
  }
}

/** Close the shared readline interface. Must be called before process exit. */
export function close(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}
