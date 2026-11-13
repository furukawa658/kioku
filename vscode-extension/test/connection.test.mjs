import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveConnection } = require('../connection.cjs');
const { getDefaultWorkerPort } = require('../out/install-port.cjs');

test('connection honors explicit URL, environment and nested settings before the canonical install port', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kioku-vscode-'));
  try {
    const env = { CLAUDE_MEM_DATA_DIR: directory };
    assert.equal(resolveConnection('', env), `http://127.0.0.1:${getDefaultWorkerPort(directory)}`);
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '37780' } }));
    assert.equal(resolveConnection('', env), 'http://127.0.0.1:37780');
    assert.equal(resolveConnection('', { ...env, CLAUDE_MEM_WORKER_PORT: '37781' }), 'http://127.0.0.1:37781');
    assert.equal(resolveConnection('http://localhost:37782', env), 'http://localhost:37782');
    assert.throws(() => resolveConnection('', { ...env, CLAUDE_MEM_WORKER_PORT: '0' }), /port setting is invalid/);
    assert.throws(() => resolveConnection('', { ...env, CLAUDE_MEM_WORKER_PORT: 'bad' }), /port setting is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});