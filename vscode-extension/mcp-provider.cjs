const runtime = require('./runtime.cjs');

function createMcpProvider(vscode, extensionPath, runtimeApi = runtime) {
  const options = () => runtimeApi.runtimeOptions(extensionPath, vscode.workspace.getConfiguration('kioku').get('workerUrl', ''));
  return {
    provideMcpServerDefinitions() {
      const current = options();
      return [new vscode.McpStdioServerDefinition('kioku (local)', current.command, [current.mcp], current.overrides, current.version)];
    },
    async resolveMcpServerDefinition(server, token) {
      if (token.isCancellationRequested) return undefined;
      const current = options();
      await runtimeApi.ensureRuntime(current);
      if (token.isCancellationRequested) return undefined;
      server.command = current.command;
      server.args = [current.mcp];
      server.env = current.overrides;
      server.version = current.version;
      server.cwd = vscode.Uri.file(current.root);
      return server;
    }
  };
}

module.exports = { createMcpProvider };