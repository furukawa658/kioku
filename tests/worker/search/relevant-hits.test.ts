import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { relevantHits } from '../../../src/services/vector/SQLiteVecSearch.js';
import { invalidateMemory } from '../../../src/services/memory/invalidate-memory.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

afterEach(() => { delete process.env.KIOKU_VECTOR_MIN_Z; });

const hits = (distances: number[]) => distances.map((distance, i) => ({ key: `k${i}`, distance }));

test('keeps only hits that stand out from the other scores', () => {
  const noise = Array.from({ length: 30 }, (_, i) => 0.2 + (i % 5) * 0.01);
  const kept = relevantHits(hits([0.02, 0.03, ...noise].sort((a, b) => a - b)));
  expect(kept.map(h => h.distance)).toEqual([0.02, 0.03]);
});

test('uses the 1.4 default and allows the stricter 1.5 override', () => {
  const flat = Array.from({ length: 30 }, (_, i) => 0.2 + (i % 5) * 0.01).sort((a, b) => a - b);
  expect(relevantHits(hits(flat))).toHaveLength(6);
  process.env.KIOKU_VECTOR_MIN_Z = '1.5';
  expect(relevantHits(hits(flat))).toEqual([]);
});

test('skips the cutoff for small sets and when disabled', () => {
  expect(relevantHits(hits([0.1, 0.2, 0.3])).length).toBe(3);
  process.env.KIOKU_VECTOR_MIN_Z = '0';
  expect(relevantHits(hits(Array.from({ length: 30 }, () => 0.2))).length).toBe(30);
});

test('invalidated observations leave search and come back on restore', () => {
  const store = new SessionStore(':memory:');
  try {
    const sessionId = store.getOrCreateManualSession('p', 'claude');
    const add = (title: string) => store.storeObservation(sessionId, 'p', {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title, concepts: [], files_read: [], files_modified: [],
    } as never, 0, 0, undefined, undefined, { skipTitleDedup: true }).id;
    const stale = add('alpha stale note');
    const fresh = add('alpha fresh note');
    const search = new SessionSearch(store.db);
    const ids = () => search.searchObservations('alpha', { project: 'p' }).map(row => row.id).sort();
    expect(ids()).toEqual([stale, fresh]);
    expect(invalidateMemory(store.db as Database, { id: stale, reason: 'old', replacedBy: fresh }).invalidated).toBe(true);
    expect(ids()).toEqual([fresh]);
    expect(invalidateMemory(store.db as Database, { id: 9999 }).success).toBe(false);
    expect(invalidateMemory(store.db as Database, { id: stale, restore: true }).invalidated).toBe(false);
    expect(ids()).toEqual([stale, fresh]);
  } finally { store.close(); }
});
