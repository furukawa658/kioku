import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSemantic, download } from './stage-semantic.mjs';

const extension = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(extension);
const runtime = path.join(extension, 'runtime');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
await mkdir(path.join(runtime, 'scripts'), { recursive: true });
await mkdir(path.join(runtime, 'licenses'), { recursive: true });
const bun = process.env.KIOKU_BUN_EXE || execFileSync('where.exe', ['bun.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
await cp(bun, path.join(runtime, 'bun.exe'));
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
    external: ['bun:*', 'sharp', 'onnxruntime-node', '@huggingface/transformers', 'tree-sitter-*', '@tree-sitter-grammars/*', '@derekstride/*', 'better-auth', 'better-auth/*', '@better-auth/*', 'supports-color']
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = input.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) packages.add(match[1]);
  }
}
const notices = [`kioku ${manifest.version}`, `Bun ${bunVersion} (MIT; includes separately licensed components)`,
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