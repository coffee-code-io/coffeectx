import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  execElevated,
  normalizeConfig,
  parseDotenv,
  resolveProject,
  sha256File,
  validateExecRequest,
  type SecretsConfig,
  type WhitelistRule,
} from '../src/index.js';

test('normalizes config and rejects env secret provider', () => {
  assert.throws(
    () => normalizeConfig({
      projects: {
        app: {
          directory: '/tmp/app',
          secrets: {
            TOKEN: { provider: 'env', key: 'TOKEN' },
          },
        },
      },
    }),
    /unsupported provider "env"/,
  );
});

test('resolves project by longest cwd prefix and explicit override', () => {
  const config: SecretsConfig = {
    projects: {
      parent: { directory: '/tmp/work', whitelist: [], secrets: {} },
      child: { directory: '/tmp/work/app', whitelist: [], secrets: {} },
    },
  };

  assert.equal(resolveProject(config, { cwd: '/tmp/work/app/src' }).projectName, 'child');
  assert.equal(resolveProject(config, { cwd: '/tmp/work/app/src', projectName: 'parent' }).projectName, 'parent');
});

test('rejects env and secret names not allowed by matched whitelist rule', () => {
  const config = fixtureConfig(process.cwd(), {
    command: '^/bin/echo',
    file_hashes: {
      '/bin/bash': sha256File('/bin/bash'),
      '/bin/echo': sha256File('/bin/echo'),
    },
    allowed_env: ['SAFE'],
    secrets: ['TOKEN'],
  });

  const badEnv = validateExecRequest(config, {
    command: '/bin/echo hi',
    secrets: ['TOKEN'],
    env: { UNSAFE: 'x' },
  });
  assert.equal(badEnv.status, 'rejected');
  assert.match(badEnv.warning ?? '', /env vars not allowed/);

  const badSecret = validateExecRequest(config, {
    command: '/bin/echo hi',
    secrets: ['OTHER'],
  });
  assert.equal(badSecret.status, 'rejected');
  assert.match(badSecret.warning ?? '', /secrets not allowed/);
});

test('rejects hash mismatch and reports unmatched command separately', () => {
  const config = fixtureConfig(process.cwd(), {
    command: '^/bin/echo',
    file_hashes: {
      '/bin/bash': '0'.repeat(64),
      '/bin/echo': sha256File('/bin/echo'),
    },
    allowed_env: [],
    secrets: [],
  });

  const mismatch = validateExecRequest(config, { command: '/bin/echo hi', secrets: [] });
  assert.equal(mismatch.status, 'rejected');
  assert.match(mismatch.warning ?? '', /hash mismatch/);

  const unmatched = validateExecRequest(config, { command: '/bin/pwd', secrets: [] });
  assert.equal(unmatched.status, 'unmatched');
  assert.match(unmatched.warning ?? '', /did not match/);
});

test('parses dotenv values', () => {
  assert.deepEqual(parseDotenv('A=1\nB="two words"\n# comment\nC=\'three\'\n'), {
    A: '1',
    B: 'two words',
    C: 'three',
  });
});

test('executes whitelisted command with dotenv and inline secrets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-core-'));
  const envFile = path.join(tmp, '.env');
  const configFile = path.join(tmp, 'secrets.yaml');
  fs.writeFileSync(envFile, 'TOKEN=dotenv-token\n');
  fs.writeFileSync(configFile, `
projects:
  app:
    directory: ${JSON.stringify(tmp)}
    whitelist:
      - command: "^/bin/echo"
        file_hashes:
          /bin/bash: "${sha256File('/bin/bash')}"
          /bin/echo: "${sha256File('/bin/echo')}"
        allowed_env: ["VISIBLE"]
        secrets: ["TOKEN", "INLINE_SECRET"]
    secrets:
      TOKEN:
        provider: dotenv
        file: ${JSON.stringify(envFile)}
      INLINE_SECRET:
        provider: inline
        value: inline-value
`);

  const result = await execElevated({
    command: '/bin/echo "$TOKEN:$INLINE_SECRET:$VISIBLE"',
    secrets: ['TOKEN', 'INLINE_SECRET'],
    env: { VISIBLE: 'visible' },
    cwd: tmp,
  }, { configPath: configFile });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), 'dotenv-token:inline-value:visible');
});

function fixtureConfig(directory: string, rule: WhitelistRule): SecretsConfig {
  return {
    projects: {
      app: {
        directory,
        whitelist: [rule],
        secrets: {
          TOKEN: { provider: 'inline', value: 'secret' },
        },
      },
    },
  };
}
