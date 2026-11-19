import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { ensureRuntime, launchWorker, probe } = createRequire(import.meta.url)('../runtime.cjs');
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

test('connection refused delegates worker startup to the native launcher', async () => {
  let launched = 0;
  let probes = 0;
  const launchOptions = { ...options, launcher: 'kioku-launcher', command: 'bun.exe', worker: 'worker.cjs', mcp: 'mcp.cjs', root: '.', dataDir: '.', env: {} };
  await ensureRuntime(launchOptions, {
    existsSync: () => true,
    launchWorker: async received => {
      launched++;
      assert.equal(received, launchOptions);
    },
    interval: 1,
    fetch: async url => {
      probes++;
      if (probes === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      return Response.json(url.endsWith('/health') ? { version: launchOptions.version } : {});
    }
  });
  assert.equal(launched, 1);
  assert.equal(probes, 3);
});

test('startup retries only after sustained connection refusal', async () => {
  let launched = 0;
  let probes = 0;
  const launchOptions = { ...options, launcher: 'kioku-launcher', command: 'bun.exe', worker: 'worker.cjs', mcp: 'mcp.cjs', root: '.', dataDir: '.', env: {} };
  await ensureRuntime(launchOptions, {
    existsSync: () => true,
    launchWorker: async () => { launched++; },
    timeout: 500,
    interval: 1,
    retryInterval: 5,
    fetch: async () => {
      probes++;
      if (launched < 2) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      return Response.json({ version: launchOptions.version, localVectorSearch: true });
    }
  });
  assert.equal(launched, 2);
  assert.ok(probes >= 3);
});

test('native launcher is detached and unreferenced after spawn', async () => {
  const launchOptions = { launcher: 'kioku-launcher', command: 'bun.exe', worker: 'worker.cjs', root: '.', env: {} };
  const child = new EventEmitter();
  let unref = 0;
  child.unref = () => { unref++; };
  const launched = launchWorker(launchOptions, (command, args, received) => {
    assert.equal(command, launchOptions.launcher);
    assert.deepEqual(args, [launchOptions.command, launchOptions.worker, launchOptions.root]);
    assert.equal(received.detached, true);
    assert.equal(received.stdio, 'ignore');
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  await launched;
  assert.equal(unref, 1);
});

test('all-in-one extension rejects a keyword-only shared worker without stopping it', async () => {
  const local = { ...options, requireLocalVectors: true };
  await assert.rejects(probe(local, async () => Response.json({ version: options.version })), /local vector search/);
  assert.equal(await probe(local, async () => Response.json({ version: options.version, localVectorSearch: true })), true);
});