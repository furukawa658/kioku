import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SQLiteVecIndex } from '../../../src/services/vector/SQLiteVecIndex.js';

describe('SQLiteVecIndex', () => {
  test('ranks real SQLite vectors and restricts candidates before ranking', () => {
    const db = new Database(':memory:');
    try {
      const index = new SQLiteVecIndex(db, 'test-model', 2);
      index.put('outside', 'hash', new Float32Array([1, 0]));
      index.put('near', 'hash', new Float32Array([0.9, 0.1]));
      index.put('far', 'hash', new Float32Array([0, 1]));
      expect(index.nearest(new Float32Array([1, 0]), ['far', 'near'], 2).map(row => row.key)).toEqual(['near', 'far']);
      expect(index.has('near', 'hash')).toBe(true);
      expect(index.has('near', 'changed')).toBe(false);
      index.delete('near');
      expect(index.nearest(new Float32Array([1, 0]), ['near'], 1)).toEqual([]);
    } finally { db.close(); }
  });

  test('reuses persisted data and excludes vectors from another model', () => {
    const db = new Database(':memory:');
    try {
      new SQLiteVecIndex(db, 'old', 2).put('saved', 'hash', new Float32Array([1, 0]));
      expect(new SQLiteVecIndex(db, 'old', 2).has('saved', 'hash')).toBe(true);
      const current = new SQLiteVecIndex(db, 'new', 2);
      expect(current.has('saved', 'hash')).toBe(false);
      expect(current.nearest(new Float32Array([1, 0]), ['saved'], 1)).toEqual([]);
      current.put('saved', 'hash', new Float32Array([0, 1]));
      expect(current.has('saved', 'hash')).toBe(true);
    } finally { db.close(); }
  });

  test('rejects invalid vectors without corrupting stored values', () => {
    const db = new Database(':memory:');
    try {
      const index = new SQLiteVecIndex(db, 'test', 2);
      for (const vector of [[1], [0, 0], [NaN, 1], [Infinity, 0]]) {
        expect(() => index.put('bad', 'hash', new Float32Array(vector))).toThrow('Invalid embedding');
      }
      expect(() => index.nearest(new Float32Array([1, 0]), [], -1)).toThrow();
    } finally { db.close(); }
  });

  test('distances equal the cosine distance', () => {
    const db = new Database(':memory:');
    try {
      const index = new SQLiteVecIndex(db, 'test', 2);
      index.put('a', 'h', new Float32Array([1, 0]));
      index.put('b', 'h', new Float32Array([0, 1]));
      index.put('c', 'h', new Float32Array([3, 0]));
      const results = index.nearest(new Float32Array([1, 0]), ['a', 'b', 'c'], 3);
      expect(results.map(r => r.key)).toEqual(['a', 'c', 'b']);
      expect(results[0].distance).toBeCloseTo(0, 6);
      expect(results[1].distance).toBeCloseTo(0, 6);
      expect(results[2].distance).toBeCloseTo(1, 6);
    } finally { db.close(); }
  });

  test('limit truncates after sorting', () => {
    const db = new Database(':memory:');
    try {
      const index = new SQLiteVecIndex(db, 'test', 2);
      index.put('a', 'h', new Float32Array([1, 0]));
      index.put('b', 'h', new Float32Array([0, 1]));
      index.put('c', 'h', new Float32Array([3, 0]));
      const results = index.nearest(new Float32Array([1, 0]), ['a', 'b', 'c'], 1);
      expect(results.map(r => r.key)).toEqual(['a']);
    } finally { db.close(); }
  });

  test('a stored BLOB with the wrong byte length makes nearest throw', () => {
    const db = new Database(':memory:');
    try {
      const index = new SQLiteVecIndex(db, 'test', 2);
      db.query("INSERT INTO local_vectors (key, model_id, content_hash, embedding) VALUES ('broken', 'test', 'h', ?)").run(new Uint8Array(4));
      expect(() => index.nearest(new Float32Array([1, 0]), ['broken'], 1)).toThrow('Stored embedding has unexpected dimensions');
    } finally { db.close(); }
  });
});