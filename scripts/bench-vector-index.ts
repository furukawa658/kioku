/**
 * Compare the production sqlite-vec flat index with a USearch HNSW candidate.
 * Run with: bun scripts/bench-vector-index.ts [counts] [queries]
 * Example: bun scripts/bench-vector-index.ts 1000,10000,50000,100000 20
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Database } from 'bun:sqlite';
import { Index, MetricKind, ScalarKind, exactSearch } from 'usearch';

const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec') as { load(database: Database): void };
const counts = (process.argv[2] ?? '1000,10000,50000,100000')
  .split(',')
  .map(Number);
const queryCount = Number(process.argv[3] ?? 20);
const dimensions = 384;
const topK = 10;
const repeats = 5;

if (!counts.length || counts.some(value => !Number.isSafeInteger(value) || value < 1)) {
  throw new Error('counts must be a comma-separated list of positive integers');
}
if (!Number.isSafeInteger(queryCount) || queryCount < 1) {
  throw new Error('queries must be a positive integer');
}

function progress(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function vectorAt(data: Float32Array, row: number): Float32Array {
  return data.subarray(row * dimensions, (row + 1) * dimensions);
}

function randomVectors(count: number): Float32Array {
  const data = new Float32Array(count * dimensions);
  let state = 0x9e3779b9;
  for (let row = 0; row < count; row++) {
    let norm = 0;
    for (let column = 0; column < dimensions; column++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const offset = row * dimensions + column;
      const value = ((state >>> 0) / 0x1_0000_0000) * 2 - 1;
      data[offset] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    const start = row * dimensions;
    for (let column = 0; column < dimensions; column++) data[start + column] /= norm;
  }
  return data;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function recall(matches: BigUint64Array[], expected: BigUint64Array[]): number {
  let hitCount = 0;
  for (let query = 0; query < expected.length; query++) {
    const expectedKeys = new Set(expected[query]);
    for (const key of matches[query]) if (expectedKeys.has(key)) hitCount++;
  }
  return hitCount / (expected.length * topK);
}

function rssMiB(): number {
  return Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2));
}

function benchmarkCount(count: number): Record<string, unknown> {
  progress(`start count=${count} dimensions=${dimensions} queries=${queryCount}`);
  const data = randomVectors(count);
  const queries = Array.from({ length: Math.min(queryCount, count) }, (_, index) => {
    const row = (index * 7919 + 17) % count;
    return vectorAt(data, row);
  });

  try {
    const database = new Database(':memory:');
    sqliteVec.load(database);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE VIRTUAL TABLE bench_vectors USING vec0(
        embedding float[${dimensions}], key text
      );
    `);
    const insert = database.prepare('INSERT INTO bench_vectors(rowid, embedding, key) VALUES (?, vec_f32(?), ?)');
    const sqliteBuildStarted = performance.now();
    database.transaction(() => {
      for (let row = 0; row < count; row++) {
        const vector = vectorAt(data, row);
        const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        insert.run(row + 1, bytes, `row-${row}`);
      }
    })();
    const sqliteBuildMs = performance.now() - sqliteBuildStarted;
    const sqliteSearch = database.prepare(`SELECT rowid, distance FROM bench_vectors
      WHERE embedding MATCH vec_f32(?) AND k = ? ORDER BY distance`);

    const usearch = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F32,
      connectivity: 16,
      expansion_add: 128,
      expansion_search: 64,
      multi: false,
    });
    const usearchBuildStarted = performance.now();
    usearch.add(
      BigUint64Array.from({ length: count }, (_, index) => BigInt(index + 1)),
      data,
      0,
    );
    const usearchBuildMs = performance.now() - usearchBuildStarted;

    const exactStarted = performance.now();
    const exact = exactSearch(data, queries, dimensions, topK, MetricKind.Cos, 1) as {
      keys: BigUint64Array;
      counts: BigUint64Array;
      get(index: number): { keys: BigUint64Array };
    };
    const expected = queries.map((_, index) =>
      BigUint64Array.from(exact.get(index).keys, key => key + 1n));
    const exactMs = performance.now() - exactStarted;

    const sqliteMatches: BigUint64Array[] = [];
    const usearchMatches: BigUint64Array[] = [];
    const sqliteSamples: number[] = [];
    const usearchSamples: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let query = 0; query < queries.length; query++) {
        const vector = queries[query];
        const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
        const sqliteStarted = performance.now();
        const rows = sqliteSearch.all(bytes, topK) as Array<{ rowid: number }>;
        sqliteSamples.push(performance.now() - sqliteStarted);
        if (repeat === 0) sqliteMatches.push(BigUint64Array.from(rows, row => BigInt(row.rowid)));

        const usearchStarted = performance.now();
        const result = usearch.search(vector, topK, 1);
        usearchSamples.push(performance.now() - usearchStarted);
        if (repeat === 0) usearchMatches.push(result.keys);
      }
    }

    const result = {
      count,
      dimensions,
      queryCount: queries.length,
      topK,
      exactMs: Number(exactMs.toFixed(3)),
      sqliteVec: {
        buildMs: Number(sqliteBuildMs.toFixed(3)),
        searchP50Ms: Number(percentile(sqliteSamples, 0.5).toFixed(6)),
        searchP95Ms: Number(percentile(sqliteSamples, 0.95).toFixed(6)),
        recallAt10: Number(recall(sqliteMatches, expected).toFixed(4)),
      },
      usearch: {
        buildMs: Number(usearchBuildMs.toFixed(3)),
        searchP50Ms: Number(percentile(usearchSamples, 0.5).toFixed(6)),
        searchP95Ms: Number(percentile(usearchSamples, 0.95).toFixed(6)),
        recallAt10: Number(recall(usearchMatches, expected).toFixed(4)),
      },
      rssMiB: rssMiB(),
    };
    insert.finalize();
    sqliteSearch.finalize();
    database.close(true);
    progress(`completed count=${count} sqlite_p50_ms=${result.sqliteVec.searchP50Ms} usearch_p50_ms=${result.usearch.searchP50Ms} usearch_recall=${result.usearch.recallAt10}`);
    return result;
  } finally {
    // sqlite-vec keeps its native database handle until process exit on Windows.
  }
}

progress(`vector benchmark start counts=${counts.join(',')} total=${counts.length}`);
const started = performance.now();
const results = counts.map(benchmarkCount);
const output = { completed: true, elapsedMs: Number((performance.now() - started).toFixed(3)), results };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
progress(`vector benchmark completed counts=${results.length} failed=0 elapsed_ms=${output.elapsedMs}`);
