import { Database } from 'bun:sqlite';

export class SQLiteVecIndex {
  constructor(
    private readonly db: Database,
    readonly modelId: string,
    readonly dims: number,
  ) {
    if (!Number.isInteger(dims) || dims < 1) throw new Error('Invalid vector dimensions');
    db.exec(`CREATE TABLE IF NOT EXISTS local_vectors (
      key TEXT PRIMARY KEY, model_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL
    )`);
  }

  has(key: string, contentHash: string): boolean {
    return !!this.db.query('SELECT 1 FROM local_vectors WHERE key = ? AND model_id = ? AND content_hash = ?')
      .get(key, this.modelId, contentHash);
  }

  put(key: string, contentHash: string, vector: Float32Array): void {
    const blob = this.serialize(vector);
    this.db.query(`INSERT INTO local_vectors (key, model_id, content_hash, embedding) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET model_id=excluded.model_id,
      content_hash=excluded.content_hash, embedding=excluded.embedding`)
      .run(key, this.modelId, contentHash, blob);
  }

  nearest(vector: Float32Array, keys: string[], limit: number): Array<{ key: string; distance: number }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid vector result limit');
    this.serialize(vector);
    if (!keys.length) return [];

    let queryNorm = 0;
    for (let i = 0; i < vector.length; i++) queryNorm += vector[i] * vector[i];
    queryNorm = Math.sqrt(queryNorm);

    const rows = this.db.query(
      'SELECT key, embedding FROM local_vectors WHERE model_id = ? AND key IN (SELECT value FROM json_each(?))',
    ).all(this.modelId, JSON.stringify(keys)) as Array<{ key: string; embedding: Uint8Array }>;

    const candidates: Array<{ key: string; distance: number }> = [];
    for (const row of rows) {
      const bytes = row.embedding;
      if (bytes.byteLength !== this.dims * 4) {
        throw new Error('Stored embedding has unexpected dimensions');
      }
      const emb = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      let dot = 0;
      let embNorm = 0;
      for (let i = 0; i < this.dims; i++) {
        dot += vector[i] * emb[i];
        embNorm += emb[i] * emb[i];
      }
      embNorm = Math.sqrt(embNorm);
      const denominator = queryNorm * embNorm;
      const distance = denominator === 0 ? 1 : 1 - dot / denominator;
      candidates.push({ key: row.key, distance });
    }

    candidates.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

    return candidates.slice(0, limit);
  }

  delete(key: string): void {
    this.db.query('DELETE FROM local_vectors WHERE key = ?').run(key);
  }

  private serialize(vector: Float32Array): Uint8Array {
    if (vector.length !== this.dims || vector.some(value => !Number.isFinite(value))
      || !vector.some(value => value !== 0)) throw new Error('Invalid embedding');
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  }
}