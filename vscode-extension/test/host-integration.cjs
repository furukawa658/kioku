const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

exports.run = async function () {
  const vscode = require('vscode');
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'kioku-vscode-host-'));
  process.env.CLAUDE_MEM_DATA_DIR = path.join(isolated, 'data');
  process.env.CLAUDE_CONFIG_DIR = path.join(isolated, 'claude');
  const extensionPath = path.dirname(__dirname);
  const { createMcpProvider } = require('../mcp-provider.cjs');
  let url;
  try {
    const extension = vscode.extensions.getExtension('furukawa658.kioku-search');
    assert.ok(extension, 'Extension must be discovered');
    await extension.activate();
    assert.equal(extension.isActive, true);
    const provider = createMcpProvider(vscode, extensionPath);
    const [definition] = provider.provideMcpServerDefinitions();
    assert.ok(definition instanceof vscode.McpStdioServerDefinition);
    assert.equal(path.basename(definition.command), 'bun.exe');
    const cancellation = new vscode.CancellationTokenSource();
    const resolved = await provider.resolveMcpServerDefinition(definition, cancellation.token);
    cancellation.dispose();
    url = resolved.env.CLAUDE_MEM_WORKER_URL;
    assert.equal(resolved.env.CLAUDE_MEM_OBSERVER_ENABLED, 'false');
    assert.equal(resolved.env.CLAUDE_MEM_RUNTIME, 'worker');
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.version, '15.16.0');
    assert.equal(health.initialized, true);
    const result = { status: 'passed', vscodeVersion: vscode.version, extensionVersion: extension.packageJSON.version, workerVersion: health.version, isolatedData: isolated, copilotCalls: 0 };
    fs.writeFileSync(path.join(extensionPath, 'test', 'host-result.json'), JSON.stringify(result, null, 2));
    console.log('VSCODE_HOST_INTEGRATION_OK');
  } finally {
    if (url) await fetch(`${url}/api/admin/shutdown`, { method: 'POST' }).catch(() => {});
  }
};