import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { renderIcon } from './render-icon.mjs';

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

// Chrome channelはlinux-arm64に存在しないため、CIではコミット済みPNGを使う
if (!process.env.CI) await renderIcon();