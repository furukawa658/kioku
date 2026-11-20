import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSemantic, download } from './stage-semantic.mjs';

const extension = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(extension);
const runtime = path.join(extension, 'runtime');
const supported = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
if (!supported.includes(`${process.platform}-${process.arch}`)) throw new Error(`Unsupported build host: ${process.platform}-${process.arch}. Build on one of ${supported.join(', ')}.`);
const windows = process.platform === 'win32';
await mkdir(path.join(runtime, 'scripts'), { recursive: true });
await mkdir(path.join(runtime, 'licenses'), { recursive: true });
await rm(path.join(runtime, 'kioku-worker-launcher.exe'), { force: true });
await rm(path.join(runtime, 'kioku-worker-launcher'), { force: true });
await rm(path.join(runtime, 'kioku-worker.exe'), { force: true });
await rm(path.join(runtime, 'kioku-worker'), { force: true });
// Bunはネイティブバイナリのため、ビルドしたOSと同じ実行環境向けのVSIXになる
const bun = process.env.KIOKU_BUN_EXE || execFileSync(windows ? 'where.exe' : 'which', [windows ? 'bun.exe' : 'bun'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
await cp(bun, path.join(runtime, windows ? 'bun.exe' : 'bun'));
if (!windows) await chmod(path.join(runtime, 'bun'), 0o755);
const manifest = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'kioku-bundled-runtime', version: manifest.version, private: true }));
await cp(path.join(repo, 'plugin', 'modes'), path.join(runtime, 'modes'), { recursive: true });
await cp(path.join(repo, 'LICENSE'), path.join(runtime, 'licenses', 'kioku-LICENSE'));
const packages = new Set();
for (const name of ['worker-service', 'mcp-server', 'context-read-worker', 'work-view-read-worker']) {
  console.log(`Bundling ${name}`);
  const result = await build({
    absWorkingDir: repo,
    entryPoints: [path.join(repo, 'plugin', 'scripts', `${name}.cjs`)],
    outfile: path.join(runtime, 'scripts', `${name}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify: true, metafile: true,
    external: ['bun:*', 'sharp', 'sqlite-vec', 'onnxruntime-node', '@huggingface/transformers', 'tree-sitter-*', '@tree-sitter-grammars/*', '@derekstride/*', 'better-auth', 'better-auth/*', '@better-auth/*', 'supports-color']
  });
  const outfile = path.join(runtime, 'scripts', `${name}.cjs`);
  await writeFile(outfile, (await readFile(outfile, 'utf8')).replace(/[ \t]+$/gm, ''));
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = input.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) packages.add(match[1]);
  }
}
const sqliteVecPlatform = process.platform === 'win32' ? `sqlite-vec-windows-${process.arch}`
  : `sqlite-vec-${process.platform}-${process.arch}`;
await mkdir(path.join(runtime, 'node_modules'), { recursive: true });
for (const name of ['sqlite-vec', sqliteVecPlatform]) {
  const destination = path.join(runtime, 'node_modules', name);
  await rm(destination, { recursive: true, force: true });
  await cp(path.join(repo, 'node_modules', name), destination, {
    recursive: true, filter: file => !/\.(?:d\.ts|map)$/i.test(file),
  });
}
const notices = [`kioku ${manifest.version}`, `Bun ${bunVersion} (MIT; includes separately licensed components)`,
  'sqlite-vec 0.1.9: MIT OR Apache-2.0',
  'Local SQLite vector search and offline multilingual embeddings included. Remote server authentication and code parsing are not included.',
  ...await stageSemantic(repo, runtime)];
for (const name of [...packages].sort()) {
  const root = path.join(repo, 'node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  notices.push(`${name}@${pkg.version}: ${JSON.stringify(pkg.license || pkg.licenses || 'see package license')}`);
  const licenseFiles = (await readdir(root)).filter(file => /^(license|licence|notice|copying)(\.|$)/i.test(file));
  if (!licenseFiles.length) throw new Error(`Missing redistribution license for ${name}`);
  for (const file of licenseFiles) {
    await cp(path.join(root, file), path.join(runtime, 'licenses', `${name.replaceAll('/', '-')}-${file}`));
  }
}
await download(`https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`, path.join(runtime, 'licenses', 'bun-LICENSE.md'));
await writeFile(path.join(runtime, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n') + '\n');
async function hashes(dir) {
  const entries = [];
  for (const name of (await readdir(dir)).sort()) {
    const file = path.join(dir, name);
    if ((await stat(file)).isDirectory()) entries.push(...await hashes(file));
    else if (name !== 'integrity.json') entries.push([path.relative(runtime, file).replaceAll('\\', '/'), createHash('sha256').update(await readFile(file)).digest('hex')]);
  }
  return entries;
}
await writeFile(path.join(runtime, 'integrity.json'), JSON.stringify({ workerVersion: manifest.version, bunVersion, files: Object.fromEntries(await hashes(runtime)) }, null, 2));
console.log(`RUNTIME_STAGED ${manifest.version} Bun ${bunVersion}`);