const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveConnection } = require('./connection.cjs');

function runtimeOptions(extensionPath, configured = '', env = process.env) {
  const { resolveDataDir } = require('./out/data-dir.cjs');
  const dataDir = resolveDataDir();
  const url = new URL(resolveConnection(configured, env));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('kioku worker must use a loopback HTTP address.');
  }
  const root = path.join(extensionPath, 'runtime');
  const worker = path.join(root, 'scripts', 'worker-service.cjs');
  const overrides = {
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_WORKER_HOST: url.hostname === '[::1]' ? '::1' : url.hostname,
      CLAUDE_MEM_WORKER_PORT: url.port || '80',
      CLAUDE_MEM_WORKER_URL: url.origin,
      CLAUDE_MEM_WORKER_SCRIPT_PATH: worker,
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_OBSERVER_ENABLED: 'false',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
      CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING: 'false',
      KIOKU_SQLITE_VEC_ENABLED: 'true',
      KIOKU_EMBEDDING_MODULE: path.join(root, 'semantic', 'transformers.mjs'),
      KIOKU_EMBEDDING_MODEL_ROOT: path.join(root, 'models'),
      CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'false',
      CLAUDE_MEM_AUTO_UPDATE: 'false',
      CLAUDE_MEM_WORK_VIEW_AGENT: 'off',
      CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'off',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off',
      DO_NOT_TRACK: '1',
      CLAUDE_MEM_TELEMETRY_ENABLED: 'false'
  };
  return {
    root, dataDir, url: url.origin, command: path.join(root, 'bun.exe'), requireLocalVectors: true,
    worker, mcp: path.join(root, 'scripts', 'mcp-server.cjs'),
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    overrides, env: { ...env, ...overrides }
  };
}

async function probe(options, request = fetch) {
  try {
    const response = await request(`${options.url}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) throw new Error(`kioku health HTTP ${response.status}`);
    const health = await response.json();
    if (health.version !== options.version) throw new Error(`kioku worker version conflict: expected ${options.version}, received ${health.version ?? 'unknown'}. Stop the other worker before retrying.`);
    if (options.requireLocalVectors && health.localVectorSearch !== true) {
      throw new Error('The existing kioku worker does not provide local vector search. Stop the older worker before retrying.');
    }
    const readiness = await request(`${options.url}/api/readiness`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    return readiness.ok;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return undefined;
    throw error;
  }
}

async function ensureRuntime(options, deps = {}) {
  const request = deps.fetch || fetch;
  const running = await probe(options, request);
  if (running) return;
  let child;
  let spawnError;
  if (running === undefined) {
    for (const file of [options.command, options.worker, options.mcp]) {
      if (!fs.existsSync(file)) throw new Error(`Missing bundled runtime: ${path.basename(file)}`);
    }
    fs.mkdirSync(options.dataDir, { recursive: true });
    child = (deps.spawn || spawn)(options.command, [options.worker, '--daemon'], {
      cwd: options.root, env: options.env, windowsHide: true, detached: true, stdio: 'ignore'
    });
    child.on('error', error => { spawnError = error; });
    child.unref();
  }
  const deadline = Date.now() + (deps.timeout ?? 60000);
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      if (await probe(options, request)) return;
    } catch (error) {
      const starting = error.name === 'TimeoutError' || ['ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code);
      if (!starting || !child) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, deps.interval ?? 250));
  }
  throw new Error('kioku worker did not become ready. See the logs in the personal data directory.');
}

module.exports = { runtimeOptions, ensureRuntime, probe };