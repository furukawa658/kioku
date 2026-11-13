import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { ensureRuntime, probe } = createRequire(import.meta.url)('../runtime.cjs');
const options = { url: 'http://127.0.0.1:39991', version: '15.16.0' };

test('ready shared worker is reused without spawning or stopping', async () => {
  let spawns = 0;
  await ensureRuntime(options, {
    fetch: async url => new Response(JSON.stringify(url.endsWith('/health') ? { version: options.version } : {})),
    spawn: () => { spawns++; throw new Error('must not spawn'); }
  });
  assert.equal(spawns, 0);
});

test('incompatible worker is rejected without spawning or changing data', async () => {
  await assert.rejects(ensureRuntime(options, {
    fetch: async () => new Response(JSON.stringify({ version: '15.12.1' })),
    spawn: () => { throw new Error('must not spawn'); }
  }), /version conflict/);
});

test('unknown HTTP listener is not replaced', async () => {
  await assert.rejects(probe(options, async () => new Response('unrelated service')), /JSON|Unexpected/);
});

test('only connection refused permits a new worker', async () => {
  assert.equal(await probe(options, async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }), undefined);
  await assert.rejects(probe(options, async () => { throw new Error('timeout'); }), /timeout/);
});

test('all-in-one extension rejects a keyword-only shared worker without stopping it', async () => {
  const local = { ...options, requireLocalVectors: true };
  await assert.rejects(probe(local, async () => Response.json({ version: options.version })), /local vector search/);
  assert.equal(await probe(local, async () => Response.json({ version: options.version, localVectorSearch: true })), true);
});