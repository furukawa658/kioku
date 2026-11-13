import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const extension = process.env.KIOKU_TEST_EXTENSION_PATH || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isolated = await mkdtemp(path.join(os.tmpdir(), 'kioku-integrated-'));
const dataDir = path.join(isolated, 'data');
await mkdir(dataDir);
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
process.env.CLAUDE_MEM_DATA_DIR = dataDir;
const { runtimeOptions, ensureRuntime } = require(path.join(extension, 'runtime.cjs'));
const options = runtimeOptions(extension, `http://127.0.0.1:${port}`);
Object.assign(options.env, {
  PATH: path.join(process.env.SystemRoot, 'System32'),
  HOME: isolated, USERPROFILE: isolated, APPDATA: isolated, LOCALAPPDATA: isolated,
  CLAUDE_CONFIG_DIR: path.join(isolated, 'claude')
});
let transport;
try {
  await ensureRuntime(options);
  assert.ok((await stat(path.join(dataDir, 'claude-mem.db'))).size > 0);
  const initial = await (await fetch(`${options.url}/api/stats`)).json();
  assert.equal(initial.database.observations, 0);
  console.log('Bundled worker ready; isolated data; system runtimes absent from PATH');
  const settingsBefore = await readFile(path.join(dataDir, 'settings.json'), 'utf8');
  await ensureRuntime(options);
  assert.equal(await readFile(path.join(dataDir, 'settings.json'), 'utf8'), settingsBefore);
  transport = new StdioClientTransport({ command: options.command, args: [options.mcp], cwd: options.root, env: options.env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000); });
  const client = new Client({ name: 'kioku-isolated-smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['save_memory', 'search', 'get_observations']) assert.ok(tools.some(tool => tool.name === name), name);
  const marker = `KIOKU_SMOKE_${Date.now()}`;
  const saved = await client.callTool({ name: 'save_memory', arguments: { text: `${marker} SQLiteデータベースのバックアップを作成して復元を確認する。`, title: marker, project: 'kioku-distribution-smoke' } });
  assert.notEqual(saved.isError, true, JSON.stringify(saved));
  const distractor = await client.callTool({ name: 'save_memory', arguments: { text: 'カレーの材料を買って夕食を作る。', title: '夕食の準備', project: 'kioku-distribution-smoke' } });
  assert.notEqual(distractor.isError, true, JSON.stringify(distractor));
  const search = await client.callTool({ name: 'search', arguments: { query: marker, project: 'kioku-distribution-smoke' } });
  assert.notEqual(search.isError, true, JSON.stringify(search));
  assert.match(JSON.stringify(search), new RegExp(marker));
  const response = await fetch(`${options.url}/api/search?query=${marker}&format=json&type=observations`);
  assert.equal(response.status, 200);
  const rows = await response.json();
  const matched = rows.observations.find(row => row.title === marker);
  assert.ok(matched, JSON.stringify(rows));
  const id = matched.id;
  const semantic = await (await fetch(`${options.url}/api/search?` + new URLSearchParams({ query: 'データベースを安全にバックアップしたい', project: 'kioku-distribution-smoke', type: 'observations', format: 'json', limit: '1' }))).json();
  assert.equal(semantic.observations[0]?.id, id, JSON.stringify(semantic));
  const detail = await client.callTool({ name: 'get_observations', arguments: { ids: [id] } });
  assert.notEqual(detail.isError, true, JSON.stringify(detail));
  assert.match(JSON.stringify(detail), new RegExp(marker));
  const { KiokuClient } = await import(pathToFileURL(path.join(extension, 'client.mjs')).href);
  const sidebar = new KiokuClient(options.url);
  const overview = await sidebar.overview();
  assert.equal(overview.count, 2);
  assert.match(JSON.stringify(await sidebar.observation(id)), new RegExp(marker));
  await client.close();
  await fetch(`${options.url}/api/admin/shutdown`, { method: 'POST' });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fetch(`${options.url}/api/health`, { signal: AbortSignal.timeout(1000) }); }
    catch { break; }
    if (Date.now() > deadline) throw new Error('Isolated worker did not stop');
    await setTimeout(100);
  }
  await ensureRuntime(options);
  assert.equal(await readFile(path.join(dataDir, 'settings.json'), 'utf8'), settingsBefore);
  assert.equal((await sidebar.overview()).count, 2);
  assert.match(JSON.stringify(await sidebar.observation(id)), new RegExp(marker));
  assert.equal((await sidebar.search({ query: 'データベースを安全にバックアップしたい', project: 'kioku-distribution-smoke' }))[0].id, id);
  console.log(`INTEGRATED_SMOKE_OK fresh_db=true preserved_after_restart=true semantic=true data=${isolated}`);
} finally {
  await transport?.close();
  try {
    await fetch(`${options.url}/api/admin/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {}
}