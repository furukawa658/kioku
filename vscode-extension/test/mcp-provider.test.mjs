import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createMcpProvider } = createRequire(import.meta.url)('../mcp-provider.cjs');

test('MCP registration uses bundled runtime, no inherited secrets, and starts only on resolution', async () => {
  let starts = 0;
  const options = { root: 'bundle', command: 'bundle/bun.exe', mcp: 'bundle/scripts/mcp-server.cjs', overrides: { DO_NOT_TRACK: '1' }, env: { SECRET: 'not-published' }, version: '15.16.0' };
  const api = {
    workspace: { getConfiguration: () => ({ get: () => '' }) },
    Uri: { file: value => value },
    McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } }
  };
  const provider = createMcpProvider(api, 'extension', { runtimeOptions: () => options, ensureRuntime: async () => { starts++; } });
  const [server] = provider.provideMcpServerDefinitions();
  assert.equal(starts, 0);
  assert.equal(server.command, options.command);
  assert.deepEqual(server.env, options.overrides);
  assert.equal(await provider.resolveMcpServerDefinition(server, { isCancellationRequested: true }), undefined);
  assert.equal(starts, 0);
  assert.equal(await provider.resolveMcpServerDefinition(server, { isCancellationRequested: false }), server);
  assert.equal(starts, 1);
  assert.equal(server.cwd, options.root);
});

test('MCP registration can use the staged Rust core with the existing worker and data directory', async () => {
  const previous = process.env.KIOKU_RUST_MCP_EXE;
  process.env.KIOKU_RUST_MCP_EXE = 'C:/tools/kioku-core.exe';
  try {
    const options = {
      root: 'bundle', command: 'bundle/bun.exe', mcp: 'bundle/scripts/mcp-server.cjs',
      dataDir: 'C:/users/test/.claude-mem', url: 'http://127.0.0.1:37777',
      overrides: { CLAUDE_MEM_DATA_DIR: 'C:/users/test/.claude-mem' }, version: '15.16.0',
    };
    const api = {
      workspace: { getConfiguration: () => ({ get: () => '' }) },
      Uri: { file: value => value },
      McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
    };
    const provider = createMcpProvider(api, 'extension', { runtimeOptions: () => options, ensureRuntime: async () => {} });
    const [server] = provider.provideMcpServerDefinitions();
    assert.equal(server.command, 'C:/tools/kioku-core.exe');
    assert.deepEqual(server.args, [
      '--database', path.join('C:/users/test/.claude-mem', 'claude-mem.db'),
      '--worker-url', 'http://127.0.0.1:37777',
    ]);
    assert.deepEqual(server.env, options.overrides);
    await provider.resolveMcpServerDefinition(server, { isCancellationRequested: false });
    assert.equal(server.cwd, options.root);
  } finally {
    if (previous === undefined) delete process.env.KIOKU_RUST_MCP_EXE;
    else process.env.KIOKU_RUST_MCP_EXE = previous;
  }
});