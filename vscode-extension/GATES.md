# Integrated Windows x64 distribution

- [x] G1: Runtime startup rejects incompatible existing workers and preserves user settings.
  CHECK: node --test test/runtime.test.mjs
  EXPECT: fail 0
  EVIDENCE: PowerShell 7, vscode-extension cwd, exit 0, 4 tests passed; isolated smoke also checks unchanged settings on reuse.
- [x] G2: Bundled MCP initializes, saves and retrieves synthetic memory in an isolated data directory without system Bun or Node.
  CHECK: node test/integrated-smoke.mjs
  EXPECT: INTEGRATED_SMOKE_OK
  EVIDENCE: PowerShell 7, vscode-extension cwd, exit 0; INTEGRATED_SMOKE_OK data=<fresh system temp directory>; worker reused only the synthetic isolated database.
- [x] G3: Existing search and summary behavior remains passing.
  CHECK: npm test
  EXPECT: fail 0
  EVIDENCE: PowerShell 7, vscode-extension cwd, exit 0, 21 tests passed.
- [x] G4: Windows x64 VSIX includes runtime, worker, MCP and redistribution notices but no user data.
  CHECK: node test/package-content.mjs ../../Kanko-AI-workspace/tmp/kioku-distribution/kioku-search-0.2.0-win32-x64.vsix
  EXPECT: PACKAGE_CONTENT_OK
  EVIDENCE: PowerShell 7, vscode-extension cwd, exit 0; PACKAGE_CONTENT_OK files=71 runtimeHashes=45; VSIX target win32-x64, 54.98 MB compressed, no user DB/settings/test files.
- [x] G5: Root types and production bundles build successfully.
  CHECK: npm --prefix .. run typecheck:root && npm --prefix .. run build
  EXPECT: All build targets compiled successfully
  EVIDENCE: PowerShell 7, root typecheck exit 0; root build exit 0, all build targets compiled successfully.
- [x] G6: The real VS Code extension host activates the packaged extension and resolves the bundled MCP definition.
  MANUAL: Run a temporary activation harness against the installed VSIX in an isolated profile.
  EVIDENCE: VS Code 1.145.3 x64, isolated extension directory, exit 0; host-result-isolated.json reports status=passed, extensionVersion=0.2.0, workerVersion=15.16.0, mcpDefinition=passed, copilotCalls=0, isolatedData=Kanko-AI-workspace/tmp/kioku-distribution/host-data-isolated.