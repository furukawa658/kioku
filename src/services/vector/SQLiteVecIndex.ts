import { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';

type StoredVector = { rowid: number; key: string; content_hash: string; embedding: Uint8Array; bit_signature: Uint8Array | null };
type SqliteVecModule = typeof import('sqlite-vec');
const sqliteVecDatabases = new WeakSet<Database>();
let sqliteVecModule: SqliteVecModule | null | undefined;

function optionalSqliteVec(): SqliteVecModule | null {
  if (sqliteVecModule !== undefined) return sqliteVecModule;
  try {
    sqliteVecModule = createRequire(import.meta.url)('sqlite-vec') as SqliteVecModule;
  } catch {
    sqliteVecModule = null;
  }
  return sqliteVecModule;
}

export class SQLiteVecIndex {
  readonly backend: 'sqlite-vec' | 'javascript';
  private readonly nativeTable: string;
  private readonly bitDims: number;

  constructor(
    private readonly db: Database,
    readonly modelId: string,
    readonly dims: number,
  ) {
    if (!Number.isInteger(dims) || dims < 1) throw new Error('Invalid vector dimensions');
    db.exec(`CREATE TABLE IF NOT EXISTS local_vectors (
      key TEXT PRIMARY KEY, model_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL, bit_signature BLOB
    )`);
    const columns = db.query('PRAGMA table_info(local_vectors)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'bit_signature')) {
      db.run('ALTER TABLE local_vectors ADD COLUMN bit_signature BLOB');
    }
    this.bitDims = Math.ceil(dims / 8) * 8;
    this.nativeTable = `local_vec_index_${dims}`;
    this.backend = this.enableSqliteVec();
  }

  private enableSqliteVec(): 'sqlite-vec' | 'javascript' {
    if (process.env.KIOKU_SQLITE_VEC_EXTENSION_DISABLED === 'true') return 'javascript';
    try {
      const sqliteVec = optionalSqliteVec();
      if (!sqliteVec) return 'javascript';
      if (!sqliteVecDatabases.has(this.db)) {
        sqliteVec.load(this.db);
        sqliteVecDatabases.add(this.db);
      }
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.nativeTable} USING vec0(
        embedding float[${this.dims}], signature bit[${this.bitDims}],
        key text, model_id text, content_hash text
      )`);
      return 'sqlite-vec';
    } catch {
      return 'javascript';
    }
  }

  has(key: string, contentHash: string): boolean {
    const row = this.storedRow(key, contentHash);
    if (!row) return false;
    if (this.backend === 'sqlite-vec') this.syncNative(row);
    return true;
  }

  put(key: string, contentHash: string, vector: Float32Array): void {
    const blob = this.serialize(vector);
    const bitSignature = this.quantize(vector);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO local_vectors (key, model_id, content_hash, embedding, bit_signature) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET model_id=excluded.model_id,
        content_hash=excluded.content_hash, embedding=excluded.embedding, bit_signature=excluded.bit_signature`)
        .run(key, this.modelId, contentHash, blob, bitSignature);
      if (this.backend === 'sqlite-vec') {
        const row = this.storedRow(key, contentHash);
        if (!row) throw new Error('Stored vector disappeared during write');
        this.syncNative(row);
      }
    })();
  }

  nearest(vector: Float32Array, keys: string[], limit: number): Array<{ key: string; distance: number }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid vector result limit');
    this.serialize(vector);
    if (!keys.length) return [];

    let candidateKeys = keys;
    if (this.backend === 'sqlite-vec') {
      for (const key of keys) {
        const row = this.storedRow(key);
        if (row) this.syncNative(row);
      }
      const native = this.nearestNative(vector, keys, limit);
      if (native) return native;
    }

    let queryNorm = 0;
    for (let i = 0; i < vector.length; i++) queryNorm += vector[i] * vector[i];
    queryNorm = Math.sqrt(queryNorm);

    if (keys.length > 256) {
      const querySignature = this.quantize(vector);
      const signatures = this.db.query(
        'SELECT key, bit_signature FROM local_vectors WHERE model_id = ? AND key IN (SELECT value FROM json_each(?))',
      ).all(this.modelId, JSON.stringify(keys)) as Array<{ key: string; bit_signature: Uint8Array | null }>;
      const withSignatures = signatures.filter(row => row.bit_signature?.byteLength === querySignature.byteLength);
      if (withSignatures.length === signatures.length && signatures.length > 0) {
        const candidateCap = Math.min(2048, Math.max(256, limit * 8));
        candidateKeys = withSignatures
          .map(row => ({ key: row.key, distance: this.hammingDistance(querySignature, row.bit_signature!) }))
          .sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key))
          .slice(0, candidateCap)
          .map(row => row.key);
      }
    }

    const rows = this.db.query(
      'SELECT key, embedding FROM local_vectors WHERE model_id = ? AND key IN (SELECT value FROM json_each(?))',
    ).all(this.modelId, JSON.stringify(candidateKeys)) as Array<{ key: string; embedding: Uint8Array }>;

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
    const row = this.storedRow(key);
    this.db.transaction(() => {
      if (row && this.backend === 'sqlite-vec') {
        this.db.query(`DELETE FROM ${this.nativeTable} WHERE rowid = ?`).run(row.rowid);
      }
      this.db.query('DELETE FROM local_vectors WHERE key = ?').run(key);
    })();
  }

  private storedRow(key: string, contentHash?: string): StoredVector | null {
    const suffix = contentHash === undefined ? '' : ' AND content_hash = ?';
    const params = contentHash === undefined ? [key, this.modelId] : [key, this.modelId, contentHash];
    return this.db.query(`SELECT rowid, key, content_hash, embedding, bit_signature
      FROM local_vectors WHERE key = ? AND model_id = ?${suffix}`).get(...params) as StoredVector | null;
  }

  private syncNative(row: StoredVector): void {
    if (row.embedding.byteLength !== this.dims * 4) throw new Error('Stored embedding has unexpected dimensions');
    if (!row.bit_signature || row.bit_signature.byteLength * 8 !== this.bitDims) {
      throw new Error('Stored bit signature has unexpected dimensions');
    }
    this.db.query(`DELETE FROM ${this.nativeTable} WHERE rowid = ?`).run(row.rowid);
    this.db.query(`INSERT INTO ${this.nativeTable}
      (rowid, embedding, signature, key, model_id, content_hash)
      VALUES (?, vec_f32(?), vec_bit(?), ?, ?, ?)`)
      .run(row.rowid, row.embedding, row.bit_signature, row.key, this.modelId, row.content_hash);
  }

  private nearestNative(vector: Float32Array, keys: string[], limit: number): Array<{ key: string; distance: number }> | null {
    if (this.backend !== 'sqlite-vec' || keys.length === 0) return null;
    try {
      let candidates = keys;
      if (keys.length > 256) {
        const candidateCap = Math.min(keys.length, Math.min(2048, Math.max(256, limit * 8)));
        const bitHits = this.db.query(`SELECT key FROM ${this.nativeTable}
          WHERE signature MATCH vec_bit(?) AND k = ? AND model_id = ?
          AND key IN (SELECT value FROM json_each(?))
          ORDER BY distance, key`).all(this.quantize(vector), candidateCap, this.modelId, JSON.stringify(keys)) as Array<{ key: string }>;
        if (bitHits.length > 0) candidates = bitHits.map(hit => hit.key);
      }
      return (this.db.query(`SELECT key, distance FROM ${this.nativeTable}
        WHERE embedding MATCH vec_f32(?) AND k = ? AND model_id = ?
        AND key IN (SELECT value FROM json_each(?))
        ORDER BY distance, key`).all(vector, Math.min(limit, candidates.length), this.modelId, JSON.stringify(candidates)) as Array<{ key: string; distance: number }>)
        .slice(0, limit);
    } catch {
      return null;
    }
  }

  private quantize(vector: Float32Array): Uint8Array {
    if (vector.length !== this.dims || vector.some(value => !Number.isFinite(value))) {
      throw new Error('Invalid embedding');
    }
    const signature = new Uint8Array(Math.ceil(vector.length / 8));
    for (let index = 0; index < vector.length; index++) {
      if (vector[index] > 0) signature[index >> 3] |= 1 << (index & 7);
    }
    return signature;
  }

  private hammingDistance(left: Uint8Array, right: Uint8Array): number {
    if (left.byteLength !== right.byteLength) throw new Error('Bit signatures have different dimensions');
    let distance = 0;
    for (let index = 0; index < left.byteLength; index++) {
      let value = left[index] ^ right[index];
      while (value !== 0) {
        value &= value - 1;
        distance++;
      }
    }
    return distance;
  }

  private serialize(vector: Float32Array): Uint8Array {
    if (vector.length !== this.dims || vector.some(value => !Number.isFinite(value))
      || !vector.some(value => value !== 0)) throw new Error('Invalid embedding');
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  }
}