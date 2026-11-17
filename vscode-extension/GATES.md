# Integrated distribution (0.4.0: win32 / darwin / linux, x64 / arm64)

- [ ] G1: Runtime startup rejects incompatible existing workers and preserves user settings.
  CHECK: node --test test/runtime.test.mjs
  EXPECT: fail 0
- [ ] G2: Bundled MCP initializes, saves and retrieves synthetic memory in an isolated data directory without system Bun or Node.
  CHECK: node test/integrated-smoke.mjs
  EXPECT: INTEGRATED_SMOKE_OK
- [ ] G3: Existing search and summary behavior remains passing.
  CHECK: npm test
  EXPECT: fail 0
- [ ] G4: Each VSIX includes the runtime, worker, MCP, the target onnxruntime binding and redistribution notices, and no foreign-platform binding or user data.
  CHECK: node test/package-content.mjs <vsix>
  EXPECT: PACKAGE_CONTENT_OK
- [ ] G5: Root types and production bundles build successfully.
  CHECK: npm --prefix .. run typecheck:root && npm --prefix .. run build
  EXPECT: All build targets compiled successfully
- [ ] G6: macOS and Linux VSIX pass G2 and G4 on a matching runner.
  CHECK: .github/workflows/package-vsix.yml matrix
  EXPECT: all 5 targets green
