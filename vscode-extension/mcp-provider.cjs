const path = require('node:path');
const runtime = require('./runtime.cjs');

function createMcpProvider(vscode, extensionPath, runtimeApi = runtime) {
  const options = () => runtimeApi.runtimeOptions(extensionPath, vscode.workspace.getConfiguration('kioku').get('workerUrl', ''));
  const definition = current => {
    const rustExecutable = process.env.KIOKU_RUST_MCP_EXE?.trim();
    if (!rustExecutable) return { command: current.command, args: [current.mcp] };
    return {
      command: rustExecutable,
      args: ['--database', path.join(current.dataDir, 'claude-mem.db'), '--worker-url', current.url],
    };
  };
  return {
    provideMcpServerDefinitions() {
      const current = options();
      const selected = definition(current);
      return [new vscode.McpStdioServerDefinition('kioku (local)', selected.command, selected.args, current.overrides, current.version)];
    },
    async resolveMcpServerDefinition(server, token) {
      if (token.isCancellationRequested) return undefined;
      const current = options();
      await runtimeApi.ensureRuntime(current);
      if (token.isCancellationRequested) return undefined;
      const selected = definition(current);
      server.command = selected.command;
      server.args = selected.args;
      server.env = current.overrides;
      server.version = current.version;
      server.cwd = vscode.Uri.file(current.root);
      return server;
    }
  };
}

module.exports = { createMcpProvider };