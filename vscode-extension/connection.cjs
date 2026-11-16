const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDefaultWorkerPort } = require('./out/install-port.cjs');
const { resolveDataDir } = require('./out/data-dir.cjs');

function resolveConnection(configured, env = process.env) {
  if (configured) return configured;
  const rawDir = env.CLAUDE_MEM_DATA_DIR || resolveDataDir();
  const dataDir = rawDir.replace(/^~(?=[/\\]|$)/, os.homedir());
  let settings = {};
  const settingsPath = path.join(dataDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    settings = parsed.env && typeof parsed.env === 'object' && Object.keys(parsed.env).some(key => key.startsWith('CLAUDE_MEM_')) ? parsed.env : parsed;
  }
  const port = Number(env.CLAUDE_MEM_WORKER_PORT || settings.CLAUDE_MEM_WORKER_PORT || getDefaultWorkerPort(dataDir));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('The kioku worker port setting is invalid.');
  return `http://127.0.0.1:${port}`;
}

module.exports = { resolveConnection };