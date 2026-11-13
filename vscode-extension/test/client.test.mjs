import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KiokuClient, workerUrl } from '../client.mjs';

test('only local HTTP worker addresses are accepted', () => {
  for (const url of ['http://127.0.0.1:37777', 'http://localhost:37777', 'http://[::1]:37777']) assert.ok(workerUrl(url));
  for (const url of ['https://example.com', 'http://127.0.0.1.example.com', 'http://user:secret@localhost', 'file:///tmp', 'http://localhost/api', 'http://localhost?token=x']) {
    assert.throws(() => workerUrl(url));
  }
});

test('search encodes filters and only sends a bounded read request', async () => {
  const client = new KiokuClient('http://127.0.0.1:37777', async (url, options) => {
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('query'), '保証 & API');
    assert.equal(url.searchParams.get('project'), 'A/B');
    assert.equal(url.searchParams.get('dateEnd'), '2026-11-11');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('type'), 'observations');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return Response.json({ observations: [{ id: 2, title: '<script>test</script>' }] });
  });
  assert.equal((await client.search({ query: ' 保証 & API ', project: 'A/B', dateStart: '2026-11-01', dateEnd: '2026-11-11' }))[0].id, 2);
});

test('blank queries, invalid dates and IDs never reach the worker', async () => {
  const client = new KiokuClient('http://localhost:37777', () => { throw new Error('unexpected network request'); });
  await assert.rejects(client.search({ query: ' ' }), /Enter search terms/);
  await assert.rejects(client.search({ query: 'x', dateStart: '2026-11-12', dateEnd: '2026-11-11' }), /end date/);
  await assert.rejects(client.search({ query: 'x', dateStart: '2026-02-30' }), /date is invalid/);
  await assert.rejects(client.observation('../delete'), /memory ID/);
});

test('overview and detail use existing read endpoints', async () => {
  const paths = [];
  const client = new KiokuClient('http://localhost:37777', async (url, options) => {
    paths.push(url.pathname);
    assert.equal(options.method, 'GET');
    const responses = {
      '/api/stats': { database: { observations: 12 }, worker: { version: '15.16.0' } },
      '/api/projects': { projects: ['kioku'] },
      '/api/observation/3': { id: 3, narrative: '本文' }
    };
    return Response.json(responses[url.pathname]);
  });
  assert.deepEqual(await client.overview(), { count: 12, version: '15.16.0', projects: ['kioku'] });
  assert.equal((await client.observation(3)).narrative, '本文');
  assert.equal(paths.length, 3);
});

test('HTTP errors and malformed responses are visible', async () => {
  const failed = new KiokuClient('http://localhost', async () => new Response('', { status: 503 }));
  await assert.rejects(failed.search({ query: 'x' }), /503/);
  const malformed = new KiokuClient('http://localhost', async () => Response.json({}));
  await assert.rejects(malformed.search({ query: 'x' }), /unexpected format/);
});

test('client and workerUrl localize error messages when language is ja', async () => {
  const client = new KiokuClient('http://localhost:37777', () => { throw new Error('unexpected network request'); }, 'ja');
  await assert.rejects(client.search({ query: ' ' }), /検索語/);
  await assert.rejects(client.observation('../delete'), /記憶ID/);
  assert.throws(() => workerUrl('https://example.com/', 'ja'), /接続先/);
  assert.throws(() => workerUrl('https://example.com/'), /connection target/);
});