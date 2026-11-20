const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { END, START, globalInstructionsPath, mcpConfig, upsertInstructions } = require('../onboarding.cjs');

test('instruction injection is idempotent and preserves surrounding text', () => {
  const original = '# Project rules\n\nKeep this line.\n';
  const first = upsertInstructions(original);
  const second = upsertInstructions(first.replace('reusable `lesson`', 'temporary `lesson`'));
  assert.equal((second.match(new RegExp(START, 'g')) || []).length, 1);
  assert.equal((second.match(new RegExp(END, 'g')) || []).length, 1);
  assert.match(second, /^# Project rules/);
  assert.match(second, /Keep this line/);
  assert.match(second, /reusable `lesson`/);
});

test('MCP snippet names the shared bundled runtime and environment', () => {
  const text = mcpConfig({ command: 'C:/extension/runtime/bun.exe', mcp: 'C:/extension/runtime/scripts/mcp-server.cjs',
    overrides: { CLAUDE_MEM_DATA_DIR: 'C:/Users/test/.claude-mem', KIOKU_SQLITE_VEC_ENABLED: 'true' } });
  const parsed = JSON.parse(text);
  assert.equal(parsed.mcpServers.kioku.command, 'C:/extension/runtime/bun.exe');
  assert.deepEqual(parsed.mcpServers.kioku.args, ['C:/extension/runtime/scripts/mcp-server.cjs']);
  assert.equal(parsed.mcpServers.kioku.env.KIOKU_SQLITE_VEC_ENABLED, 'true');
});

test('MCP snippet exports the staged Rust core for other clients', () => {
  const previous = process.env.KIOKU_RUST_MCP_EXE;
  process.env.KIOKU_RUST_MCP_EXE = 'C:/tools/kioku-core.exe';
  try {
    const parsed = JSON.parse(mcpConfig({
      dataDir: 'C:/Users/test/.claude-mem', url: 'http://127.0.0.1:37777',
      command: 'C:/extension/runtime/bun.exe', mcp: 'C:/extension/runtime/scripts/mcp-server.cjs',
      overrides: { CLAUDE_MEM_DATA_DIR: 'C:/Users/test/.claude-mem' },
    }));
    assert.equal(parsed.mcpServers.kioku.command, 'C:/tools/kioku-core.exe');
    assert.deepEqual(parsed.mcpServers.kioku.args, [
      '--database', path.join('C:/Users/test/.claude-mem', 'claude-mem.db'),
      '--worker-url', 'http://127.0.0.1:37777',
    ]);
  } finally {
    if (previous === undefined) delete process.env.KIOKU_RUST_MCP_EXE;
    else process.env.KIOKU_RUST_MCP_EXE = previous;
  }
});

test('global instruction targets stay under the VS Code user prompts directory', () => {
  assert.match(globalInstructionsPath('C:/Users/test', 'win32', { APPDATA: 'C:/Users/test/AppData/Roaming' }), /Code[\\/]User[\\/]prompts[\\/]instructions\.md$/);
  assert.match(globalInstructionsPath('/home/test', 'linux', {}), /\.config[\/]Code[\/]User[\/]prompts[\/]instructions\.md$/);
});
