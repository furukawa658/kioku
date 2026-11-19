import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const archive = process.argv[2];
if (!archive) throw new Error('Pass the VSIX path.');
const archiveBytes = (await import('node:fs')).statSync(archive).size;
const entries = new Map();
await new Promise((resolve, reject) => {
  yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
});
for (const name of ['runtime/scripts/worker-service.cjs', 'runtime/scripts/mcp-server.cjs', 'runtime/modes/code.json', 'runtime/licenses/bun-LICENSE.md', 'runtime/THIRD-PARTY-NOTICES.txt', 'runtime.cjs', 'mcp-provider.cjs', 'out/data-dir.cjs',
  'runtime/semantic/transformers.mjs', 'runtime/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx',
  'runtime/models/Xenova/multilingual-e5-small/tokenizer.json']) {
  assert.ok(entries.has(`extension/${name}`), `Missing ${name}`);
}
assert.ok(!entries.has('extension/runtime/semantic/vec0.dll'), 'vec0.dll must not be bundled');
assert.ok(![...entries.keys()].some(file => /(?:^|\/)(?:chroma|chromadb|chroma-mcp)(?:\/|\.|$)/i.test(file)), 'Chroma runtime assets must not be bundled');
const pkg = JSON.parse(entries.get('extension/package.json'));
assert.equal(pkg.version, require('../package.json').version);
for (const name of ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']) {
  assert.ok(![...entries.keys()].some(file => file.endsWith(`/${name}`)), `${name} must not be bundled`);
}
assert.ok(![...entries.keys()].some(file => file.includes('/node_modules/@img/')), 'sharp binaries must not be bundled');
assert.ok(archiveBytes <= 160 * 1048576, `VSIX too large: ${archiveBytes}`);
assert.equal(pkg.publisher.toLowerCase(), 'shunsukef');
assert.equal(pkg.contributes.configuration.properties['kioku.copilotEnabled'].default, false);
assert.equal(pkg.contributes.mcpServerDefinitionProviders[0].id, 'kioku.local');
assert.equal(pkg.extensionKind[0], 'ui');
const integrity = JSON.parse(entries.get('extension/runtime/integrity.json'));
for (const [file, hash] of Object.entries(integrity.files)) {
  const content = entries.get(`extension/runtime/${file}`);
  assert.ok(content, file);
  assert.equal(createHash('sha256').update(content).digest('hex'), hash, file);
}
const target = entries.get('extension.vsixmanifest').toString().match(/TargetPlatform="([a-z0-9-]+)"/)?.[1];
assert.ok(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target), `Unexpected target ${target}`);
const [os, arch] = target.split('-');
const bunFile = os === 'win32' ? 'runtime/bun.exe' : 'runtime/bun';
const magics = { win32: ['4d5a'], linux: ['7f454c46'], darwin: ['cffaedfe', 'cafebabe', 'bebafeca'] };
for (const binary of [bunFile]) {
  const entry = entries.get(`extension/${binary}`);
  assert.ok(entry, `Missing ${binary}`);
  const magic = entry.subarray(0, 4);
  assert.ok(magics[os].some(hex => magic.toString('hex').startsWith(hex)), `Unexpected ${binary} binary header for ${target}`);
}
assert.ok(entries.has(`extension/runtime/node_modules/onnxruntime-node/bin/napi-v6/${os}/${arch.replace('x64', 'x64')}/onnxruntime_binding.node`), `Missing onnxruntime binding for ${target}`);
assert.ok(![...entries.keys()].some(file => /kioku-worker-launcher/.test(file)), 'native launcher must not be bundled');
assert.ok(![...entries.keys()].some(file => file.startsWith('extension/runtime/node_modules/') && /\.(?:d\.ts|map)$/.test(file)), 'ONNX development artifacts must not be bundled');
for (const file of entries.keys()) {
  const other = file.match(/onnxruntime-node\/bin\/napi-v6\/([a-z0-9]+)\/([a-z0-9]+)\//);
  if (other) assert.equal(`${other[1]}-${other[2]}`, target, `Foreign onnxruntime binary: ${file}`);
}
for (const [file, content] of entries) {
  assert.doesNotMatch(file, /(?:^|\/)(?:test|logs|backups|\.env)(?:\/|$)|\.(?:db|sqlite|sqlite3)(?:-|$)|settings\.json|stage-(?:runtime|semantic)\.mjs|GATES\.md|server-service\.cjs/i);
  if (file.includes('/node_modules/')) assert.ok(file.startsWith('extension/runtime/node_modules/'), file);
  if (/\.(?:cjs|mjs|json|html|js)$/.test(file)) {
    assert.ok(!content.includes(Buffer.from('C:\\Users\\a143006')), `Personal absolute path in ${file}`);
  }
}
console.log(`PACKAGE_CONTENT_OK files=${entries.size} runtimeHashes=${Object.keys(integrity.files).length}`);