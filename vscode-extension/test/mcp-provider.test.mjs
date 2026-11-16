import test from 'node:test';
import assert from 'node:assert/strict';
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