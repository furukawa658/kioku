import { test, expect } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SQLiteVecSearch } from '../../../src/services/vector/SQLiteVecSearch.js';
import type { Embedder } from '../../../src/services/vector/types.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';

function fixture() {
  const store = new SessionStore(':memory:');
  const session = store.createSDKSession('content', 'allowed', 'ask');
  store.ensureMemorySessionIdRegistered(session, 'memory');
  const add = (title: string, project = 'allowed', epoch = 1000) => store.storeObservation('memory', project, {
    type: 'discovery', title, subtitle: null, narrative: title, facts: [], concepts: ['concept'],
    files_read: ['src/allowed.ts'], files_modified: [],
  }, 1, 0, epoch).id;
  let count = 0;
  const embedder: Embedder = {
    modelId: 'fixture', dims: 2,
    async embed(texts) { count += texts.length; return texts.map(text => new Float32Array(text.includes('meaning') || text.includes('semantic') ? [1, 0.1] : [0.1, 1])); },
  };
  const search = new SQLiteVecSearch(new SessionSearch(store.db), store, embedder);
  return { store, add, embedder, search, count: () => count };
}

test('finds meaning without keyword overlap and keeps project/type/file/date filters', async () => {
  const setup = fixture();
  try {
    const expected = setup.add('semantic stored note');
    setup.add('semantic other project', 'blocked');
    const result = await setup.search.search({ query: 'meaning', project: 'allowed', searchType: 'observations',
      obsType: 'discovery', files: ['src/allowed.ts'], concepts: ['concept'], dateRange: { start: 0, end: 2000 } });
    expect(result.results.observations.map(row => row.id)).toEqual([expected]);
    expect(result.strategy).toBe('hybrid');
    expect((await setup.search.search({ query: 'meaning', project: 'allowed', searchType: 'observations', files: ['absent.ts'] })).results.observations).toEqual([]);
    expect((await setup.search.search({ query: 'meaning', project: 'allowed', searchType: 'observations', obsType: 'bugfix' })).results.observations).toEqual([]);
    expect((await setup.search.search({ query: 'meaning', project: 'allowed', searchType: 'observations', dateRange: { start: 2000 } })).results.observations).toEqual([]);
  } finally { setup.store.close(); }
});

test('reuses unchanged vectors, reindexes edits, excludes deleted rows and pages stably', async () => {
  const setup = fixture();
  try {
    const first = setup.add('semantic first');
    const second = setup.add('ordinary second');
    const options = { query: 'meaning', project: 'allowed', searchType: 'observations' as const, limit: 1 };
    expect((await setup.search.search(options)).results.observations.map(row => row.id)).toEqual([first]);
    const count = setup.count();
    expect((await setup.search.search({ ...options, offset: 1 })).results.observations.map(row => row.id)).toEqual([second]);
    expect(setup.count()).toBe(count + 1);
    setup.store.db.query('UPDATE observations SET title = ?, narrative = ? WHERE id = ?').run('changed note', 'changed note', first);
    await setup.search.search(options);
    expect(setup.count()).toBe(count + 3);
    setup.store.db.query('DELETE FROM observations WHERE id = ?').run(first);
    expect((await setup.search.search(options)).results.observations.map(row => row.id)).toEqual([second]);
    expect(setup.store.db.query('SELECT 1 FROM local_vectors WHERE key = ?').get(`observations:${first}`)).toBeNull();
  } finally { setup.store.close(); }
});

test('retains keyword matches on embedding failure and does not embed filter-only queries', async () => {
  const setup = fixture();
  try {
    const expected = setup.add('literal identifier');
    setup.embedder.embed = async () => { throw new Error('offline model missing'); };
    const result = await setup.search.search({ query: 'literal', project: 'allowed', searchType: 'observations' });
    expect(result.results.observations.map(row => row.id)).toEqual([expected]);
    expect(result.strategy).toBe('sqlite');
    expect((await setup.search.search({ project: 'allowed', searchType: 'observations' })).results.observations.map(row => row.id)).toEqual([expected]);
    expect(setup.count()).toBe(0);
  } finally { setup.store.close(); }
});

test('normal SearchManager and corpus orchestrator use local meaning search without Chroma', async () => {
  const setup = fixture();
  try {
    const expected = setup.add('semantic stored note');
    const manager = new SearchManager(new SessionSearch(setup.store.db), setup.store, null,
      new FormattingService(), new TimelineService(), 0, null, null, setup.search);
    const result = await manager.search({ query: 'meaning', project: 'allowed', type: 'observations', format: 'json' });
    expect(result.observations.map((row: { id: number }) => row.id)).toEqual([expected]);
    const corpus = await manager.getOrchestrator().search({ query: 'meaning', project: 'allowed', searchType: 'observations' });
    expect(corpus.results.observations.map(row => row.id)).toEqual([expected]);
  } finally { setup.store.close(); }
});