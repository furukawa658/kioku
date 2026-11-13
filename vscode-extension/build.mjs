import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { renderIcon } from './render-icon.mjs';

await rm(fileURLToPath(new URL('./runtime', import.meta.url)), { recursive: true, force: true });

await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/install-port.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./out/install-port.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20'
});

await build({
  entryPoints: [fileURLToPath(new URL('../src/shared/data-dir.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./out/data-dir.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', target: 'node20'
});

await import('./stage-runtime.mjs');

await renderIcon();