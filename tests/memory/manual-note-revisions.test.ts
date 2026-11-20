import { afterEach, describe, expect, it } from 'bun:test';
import { saveMemory, saveMemoryChecked } from '../../src/services/memory/save-memory.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import type { Embedder } from '../../src/services/vector/types.js';

const originalDedup = process.env.CLAUDE_MEM_DEDUP_ENABLED;
afterEach(() => {
  if (originalDedup === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
  else process.env.CLAUDE_MEM_DEDUP_ENABLED = originalDedup;
});

describe('explicit memory note revisions', () => {
  it('stores changed prose under the same authored title while preserving exact replay identity', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = {
      getConnection: () => store.db,
      getSessionStore: () => store,
      getCloudSync: () => null,
      getChromaSync: () => null,
    };
    try {
      const search = new SessionSearch(store.db);
      const first = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to staging.' });
      const revised = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to production.' });
      expect(revised.id).not.toBe(first.id);
      expect(store.db.query('SELECT title, narrative, occurrence_count FROM observations ORDER BY id').all()).toEqual([
        { title: 'Deployment setting', narrative: 'Deploy to staging.', occurrence_count: 1 },
        { title: 'Deployment setting', narrative: 'Deploy to production.', occurrence_count: 1 },
      ]);
      const replay = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to production.' });
      expect(replay.id).toBe(revised.id);
      expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 2 });
      expect(search.searchObservations('production', { project: 'notes' }).map(row => row.id)).toEqual([revised.id]);
    } finally {
      store.close();
    }
  });

  it('keeps separate untitled notes whose first sixty characters coincide', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    try {
      const prefix = 'This deployment has a deliberately shared introduction. '.padEnd(65, 'x');
      const first = saveMemory(manager as any, 'notes', { text: `${prefix} staging` });
      const second = saveMemory(manager as any, 'notes', { text: `${prefix} production` });
      expect(second.title).toBe(first.title);
      expect(second.id).not.toBe(first.id);
    } finally {
      store.close();
    }
  });

  it('selects lessons by concept and keeps a revised lesson under the same title and text', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    try {
      const search = new SessionSearch(store.db);
      const note = { title: 'Row shift', text: 'Posted drafts were stale.' };
      const plain = saveMemory(manager as any, 'notes', { text: 'Deploy to staging.' });
      const first = saveMemory(manager as any, 'notes', { ...note, outcome: 'failure', cause: 'An inserted row.', lesson: 'Check the row count.' });
      const revised = saveMemory(manager as any, 'notes', { ...note, outcome: 'failure', cause: 'An inserted row.', lesson: 'Re-read the latest file.' });
      const success = saveMemory(manager as any, 'notes', { text: 'The build passed.', outcome: 'success', lesson: 'Pin the drive letter.' });
      expect(revised.id).not.toBe(first.id);
      const ids = (concepts: string[]) => search.searchObservations(undefined, { project: 'notes', concepts, orderBy: 'date_asc' }).map(row => row.id).sort();
      expect(ids(['lesson'])).toEqual([first.id, revised.id, success.id]);
      expect(ids(['outcome-failure'])).toEqual([first.id, revised.id]);
      expect(ids(['lesson'])).not.toContain(plain.id);
      expect(search.searchObservations('latest', { project: 'notes' }).map(row => row.id)).toEqual([revised.id]);
    } finally {
      store.close();
    }
  });

  it('rejects near duplicates and lets an explicit supersede through', async () => {
    const store = new SessionStore(':memory:');
    const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    const embedder: Embedder = {
      modelId: 'duplicate-fixture', dims: 2,
      async embed(texts) {
        return texts.map(text => text.includes('release policy')
          ? new Float32Array([1, 0])
          : new Float32Array([0, 1]));
      },
    };
    try {
      const original = saveMemory(manager as any, 'notes', {
        title: 'Release policy', text: 'The release policy uses staging.', lesson: 'Use staging first.',
      });
      const duplicate = await saveMemoryChecked(manager as any, 'notes', {
        title: 'Current release policy', text: 'The release policy uses the staging environment.', lesson: 'Always stage the build.',
      }, embedder);
      expect(duplicate).toMatchObject({ status: 'duplicate_found', existingId: original.id, existingLesson: 'Use staging first.' });
      expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 1 });

      const replacement = await saveMemoryChecked(manager as any, 'notes', {
        title: 'Release policy changed', text: 'The release policy uses production.', supersedes: original.id,
      }, embedder);
      expect(replacement).toMatchObject({ success: true, superseded: original.id });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(store.db.query('SELECT bit_signature FROM local_vectors WHERE key = ?')
        .get(`observations:${replacement.id}`)).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('saves a replacement and invalidates the superseded observation atomically', () => {
    const store = new SessionStore(':memory:');
    const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    try {
      const previous = saveMemory(manager as any, 'notes', { title: 'Policy', text: 'Use staging.' });
      const replacement = saveMemory(manager as any, 'notes', { title: 'Policy', text: 'Use production.', supersedes: previous.id });
      expect(replacement.superseded).toBe(previous.id);
      expect(store.db.query('SELECT replaced_by FROM invalidated_observations WHERE observation_id = ?').get(previous.id)).toEqual({ replaced_by: replacement.id });

      expect(() => saveMemory(manager as any, 'notes', { text: 'Rolled back', supersedes: 9999 })).toThrow('not found');
      expect(store.db.query("SELECT count(*) AS n FROM observations WHERE narrative = 'Rolled back'").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });
});
