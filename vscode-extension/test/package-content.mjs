import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const archive = process.argv[2];
if (!archive) throw new Error('Pass the Windows x64 VSIX path.');
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
for (const name of ['runtime/bun.exe', 'runtime/scripts/worker-service.cjs', 'runtime/scripts/mcp-server.cjs', 'runtime/modes/code.json', 'runtime/licenses/bun-LICENSE.md', 'runtime/THIRD-PARTY-NOTICES.txt', 'runtime.cjs', 'mcp-provider.cjs', 'out/data-dir.cjs',
  'runtime/semantic/transformers.mjs', 'runtime/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx',
  'runtime/models/Xenova/multilingual-e5-small/tokenizer.json', 'runtime/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node']) {
  assert.ok(entries.has(`extension/${name}`), `Missing ${name}`);
}
assert.ok(!entries.has('extension/runtime/semantic/vec0.dll'), 'vec0.dll must not be bundled');
const pkg = JSON.parse(entries.get('extension/package.json'));
assert.equal(pkg.version, '0.3.0');
assert.equal(pkg.contributes.configuration.properties['kioku.copilotEnabled'].default, false);
assert.equal(pkg.contributes.mcpServerDefinitionProviders[0].id, 'kioku.local');
assert.equal(pkg.extensionKind[0], 'ui');
const integrity = JSON.parse(entries.get('extension/runtime/integrity.json'));
for (const [file, hash] of Object.entries(integrity.files)) {
  const content = entries.get(`extension/runtime/${file}`);
  assert.ok(content, file);
  assert.equal(createHash('sha256').update(content).digest('hex'), hash, file);
}
assert.equal(entries.get('extension/runtime/bun.exe').subarray(0, 2).toString(), 'MZ');
assert.match(entries.get('extension.vsixmanifest').toString(), /TargetPlatform="win32-x64"/);
for (const [file, content] of entries) {
  assert.doesNotMatch(file, /(?:^|\/)(?:test|logs|backups|\.env)(?:\/|$)|\.(?:db|sqlite|sqlite3)(?:-|$)|settings\.json|stage-(?:runtime|semantic)\.mjs|GATES\.md|server-service\.cjs/i);
  if (file.includes('/node_modules/')) assert.ok(file.startsWith('extension/runtime/node_modules/'), file);
  if (/\.(?:cjs|mjs|json|html|js)$/.test(file)) {
    assert.ok(!content.includes(Buffer.from('C:\\Users\\a143006')), `Personal absolute path in ${file}`);
  }
}
console.log(`PACKAGE_CONTENT_OK files=${entries.size} runtimeHashes=${Object.keys(integrity.files).length}`);