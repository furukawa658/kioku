/**
 * Compare kioku's current SQLite connection settings with optional memory pragmas.
 * Run with: bun scripts/bench-sqlite-pragmas.ts [records] [trials]
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Database } from 'bun:sqlite';

const recordCount = Number(process.argv[2] ?? 50_000);
const trials = Number(process.argv[3] ?? 3);
const readIterations = 100;
const updateCount = Math.min(2_000, recordCount);

if (!Number.isSafeInteger(recordCount) || recordCount < 1) {
  throw new Error('records must be a positive integer');
}
if (!Number.isSafeInteger(trials) || trials < 1) {
  throw new Error('trials must be a positive integer');
}

function progress(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const configurations = [
  {
    name: 'current',
    extraPragmas: '',
  },
  {
    name: 'temp-memory',
    extraPragmas: 'PRAGMA temp_store = MEMORY;',
  },
] as const;

interface TrialResult {
  insertMs: number;
  updateMs: number;
  readP50Ms: number;
  readP95Ms: number;
  ftsP50Ms: number;
  ftsP95Ms: number;
  fileBytes: number;
  rssMiB: number;
  pragmaValues: Record<string, number | string>;
}

function runTrial(name: string, extraPragmas: string): TrialResult {
  const directory = mkdtempSync(join(tmpdir(), `kioku-sqlite-${name}-`));
  const databasePath = join(directory, 'memory.db');
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 4194304;
      PRAGMA journal_mode = WAL;
      ${extraPragmas}
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        narrative TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX observations_project_recent
        ON observations(project, invalidated, created_at_epoch DESC);
      CREATE VIRTUAL TABLE observations_fts USING fts5(title, narrative, content='observations', content_rowid='id');
    `);
    const insert = database.prepare(`
      INSERT INTO observations(id, project, title, narrative, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = database.prepare(`
      INSERT INTO observations_fts(rowid, title, narrative) VALUES (?, ?, ?)
    `);
    const insertStarted = performance.now();
    database.transaction(() => {
      for (let index = 1; index <= recordCount; index++) {
        const project = index % 3 === 0 ? 'other' : index % 2 === 0 ? 'repo-a' : 'repo-b';
        const title = `lesson ${index} SQLite lock handling`;
        const narrative = `project=${project}; rule=${index % 97}; avoid repeated build and search failures;`;
        insert.run(index, project, title, narrative, index);
        insertFts.run(index, title, narrative);
      }
    })();
    const insertMs = performance.now() - insertStarted;
    insert.finalize();
    insertFts.finalize();

    const update = database.prepare(`
      UPDATE observations SET invalidated = 1 WHERE id = ?
    `);
    const updateStarted = performance.now();
    database.transaction(() => {
      for (let index = 1; index <= updateCount; index += 2) update.run(index);
    })();
    const updateMs = performance.now() - updateStarted;
    update.finalize();

    const read = database.prepare(`
      SELECT id, project, title FROM observations
      WHERE project = ? AND invalidated = 0
      ORDER BY created_at_epoch DESC LIMIT 50
    `);
    const fts = database.prepare(`
      SELECT rowid FROM observations_fts
      WHERE observations_fts MATCH ? ORDER BY rowid DESC LIMIT 50
    `);
    for (let warmup = 0; warmup < 10; warmup++) {
      read.all(warmup % 2 === 0 ? 'repo-a' : 'repo-b');
      fts.all('SQLite AND lock');
    }
    const readSamples: number[] = [];
    const ftsSamples: number[] = [];
    for (let iteration = 0; iteration < readIterations; iteration++) {
      let started = performance.now();
      read.all(iteration % 2 === 0 ? 'repo-a' : 'repo-b');
      readSamples.push(performance.now() - started);
      started = performance.now();
      fts.all(iteration % 2 === 0 ? 'SQLite AND lock' : 'build AND failures');
      ftsSamples.push(performance.now() - started);
    }
    read.finalize();
    fts.finalize();

    database.run('PRAGMA wal_checkpoint(TRUNCATE)');
    const pragmaValues = {
      busy_timeout: database.query('PRAGMA busy_timeout').get() as { timeout: number },
      foreign_keys: database.query('PRAGMA foreign_keys').get() as { foreign_keys: number },
      synchronous: database.query('PRAGMA synchronous').get() as { synchronous: number },
      journal_mode: database.query('PRAGMA journal_mode').get() as { journal_mode: string },
      temp_store: database.query('PRAGMA temp_store').get() as { temp_store: number },
      mmap_size: database.query('PRAGMA mmap_size').get() as { mmap_size: number },
      cache_size: database.query('PRAGMA cache_size').get() as { cache_size: number },
    };
    const fileBytes = statSync(databasePath).size;
    return {
      insertMs: Number(insertMs.toFixed(3)),
      updateMs: Number(updateMs.toFixed(3)),
      readP50Ms: Number(percentile(readSamples, 0.5).toFixed(6)),
      readP95Ms: Number(percentile(readSamples, 0.95).toFixed(6)),
      ftsP50Ms: Number(percentile(ftsSamples, 0.5).toFixed(6)),
      ftsP95Ms: Number(percentile(ftsSamples, 0.95).toFixed(6)),
      fileBytes,
      rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
      pragmaValues: {
        busy_timeout: pragmaValues.busy_timeout.timeout,
        foreign_keys: pragmaValues.foreign_keys.foreign_keys,
        synchronous: pragmaValues.synchronous.synchronous,
        journal_mode: pragmaValues.journal_mode.journal_mode,
        temp_store: pragmaValues.temp_store.temp_store,
        mmap_size: pragmaValues.mmap_size.mmap_size,
        cache_size: pragmaValues.cache_size.cache_size,
      },
    };
  } finally {
    database.close(true);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

progress(`SQLite pragma benchmark start records=${recordCount} trials=${trials}`);
const started = performance.now();
const resultsByConfiguration = new Map<string, TrialResult[]>(
  configurations.map(configuration => [configuration.name, []]),
);
for (let trial = 1; trial <= trials; trial++) {
  const orderedConfigurations = trial % 2 === 0
    ? [...configurations].reverse()
    : [...configurations];
  for (const configuration of orderedConfigurations) {
    progress(`start configuration=${configuration.name} trial=${trial}/${trials}`);
    const result = runTrial(configuration.name, configuration.extraPragmas);
    resultsByConfiguration.get(configuration.name)?.push(result);
    progress(`completed configuration=${configuration.name} trial=${trial}/${trials} insert_ms=${result.insertMs} read_p50_ms=${result.readP50Ms}`);
  }
}
const results = configurations.map(configuration => {
  const trialResults = resultsByConfiguration.get(configuration.name) ?? [];
  const summary = {
    configuration: configuration.name,
    insertP50Ms: Number(percentile(trialResults.map(item => item.insertMs), 0.5).toFixed(3)),
    updateP50Ms: Number(percentile(trialResults.map(item => item.updateMs), 0.5).toFixed(3)),
    readP50Ms: Number(percentile(trialResults.map(item => item.readP50Ms), 0.5).toFixed(6)),
    readP95Ms: Number(percentile(trialResults.map(item => item.readP95Ms), 0.95).toFixed(6)),
    ftsP50Ms: Number(percentile(trialResults.map(item => item.ftsP50Ms), 0.5).toFixed(6)),
    ftsP95Ms: Number(percentile(trialResults.map(item => item.ftsP95Ms), 0.95).toFixed(6)),
    fileBytesP50: Math.trunc(percentile(trialResults.map(item => item.fileBytes), 0.5)),
    rssMiBP50: Number(percentile(trialResults.map(item => item.rssMiB), 0.5).toFixed(2)),
    pragmaValues: trialResults.at(-1)?.pragmaValues,
    trials: trialResults,
  };
  return summary;
});
const output = {
  completed: true,
  recordCount,
  trials,
  elapsedMs: Number((performance.now() - started).toFixed(3)),
  results,
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
progress(`SQLite pragma benchmark completed configurations=${results.length} failed=0 elapsed_ms=${output.elapsedMs}`);
