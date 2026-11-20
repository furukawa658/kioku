import { createHash } from 'node:crypto';
import type { DatabaseManager } from '../worker/DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { logChromaWriteFailure } from '../worker/search/errors.js';
import { notifyGrokBotIndex } from '../integrations/GrokBotIndexWriter.js';
import { notifyNotion } from '../integrations/NotionExporter.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';
import { retainTextHeadTail } from '../../shared/text-truncation.js';
import { LESSON_CONCEPT, MEMORY_OUTCOME_LABELS, memoryOutcomeConcept, type MemoryOutcome } from '../../shared/memory-lesson.js';
import { invalidateMemory } from './invalidate-memory.js';
import { SQLiteVecIndex } from '../vector/SQLiteVecIndex.js';
import { LocalEmbedder } from '../vector/LocalEmbedder.js';
import { LOCAL_EMBEDDING_MODEL } from '../vector/models.js';
import type { Embedder } from '../vector/types.js';

export interface SaveMemoryInput {
  text: string;
  title?: string;
  project?: string;
  metadata?: Record<string, unknown>;
  outcome?: MemoryOutcome;
  cause?: string;
  lesson?: string;
  supersedes?: number;
}

const saveTails = new Map<string, Promise<unknown>>();

function resolveProject(defaultProject: string, input: SaveMemoryInput): string {
  const metadataProject = typeof input.metadata?.project === 'string' && input.metadata.project.trim() ? input.metadata.project : '';
  return (input.project?.trim() ? input.project : '') || metadataProject || defaultProject;
}

function buildMemoryContent(input: SaveMemoryInput) {
  const text = input.text.trim();
  if (!text) throw new Error('Memory text must not be empty');
  const cause = input.cause?.trim();
  const lesson = input.lesson?.trim();
  const narrative = [text, [
    input.outcome ? `Outcome: ${MEMORY_OUTCOME_LABELS[input.outcome]}` : '',
    cause ? `Cause: ${cause}` : '',
    lesson ? `Lesson: ${lesson}` : '',
  ].filter(Boolean).join('\n')].filter(Boolean).join('\n\n');
  const title = input.title?.trim() || retainTextHeadTail(text, 60, 0).head.trim() + (text.length > 60 ? '...' : '');
  return { text, title, cause, lesson, narrative };
}

export async function saveMemoryChecked(
  dbManager: DatabaseManager,
  defaultProject: string,
  input: SaveMemoryInput,
  embedder?: Embedder,
) {
  const guardEnabled = embedder !== undefined || process.env.KIOKU_SQLITE_VEC_ENABLED === 'true';
  if (!guardEnabled) return saveMemory(dbManager, defaultProject, input);
  const activeEmbedder = embedder ?? new LocalEmbedder(LOCAL_EMBEDDING_MODEL, 2);
  if (input.supersedes !== undefined) {
    const result = saveMemory(dbManager, defaultProject, input);
    scheduleSavedMemoryIndex(dbManager, result.id, activeEmbedder);
    return result;
  }
  const project = resolveProject(defaultProject, input);
  const key = `${project}\0${defaultProject}`;
  const previous = saveTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const duplicate = await findNearDuplicate(dbManager, project, input, activeEmbedder);
    if (duplicate) return {
      success: false,
      status: 'duplicate_found',
      existingId: duplicate.id,
      existingLesson: duplicate.lesson,
      duplicate: true,
      message: `Memory resembles observation #${duplicate.id} (cosine similarity ${duplicate.similarity.toFixed(3)})`,
    };
    const result = saveMemory(dbManager, defaultProject, input);
    if (!result.duplicate) scheduleSavedMemoryIndex(dbManager, result.id, activeEmbedder);
    return result;
  });
  saveTails.set(key, current);
  try { return await current; }
  finally { if (saveTails.get(key) === current) saveTails.delete(key); }
}

function scheduleSavedMemoryIndex(dbManager: DatabaseManager, id: number, embedder: Embedder): void {
  void (async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = dbManager.getConnection().query('SELECT title, narrative FROM observations WHERE id = ?')
      .get(id) as { title: string; narrative: string } | null;
    if (!row) return;
    const text = [row.title, row.narrative].filter(Boolean).join('\n');
    const [vector] = await embedder.embed([text], 'passage');
    if (!vector) return;
    const index = new SQLiteVecIndex(dbManager.getConnection(), embedder.modelId, embedder.dims);
    index.put(`observations:${id}`, createHash('sha256').update(text).digest('hex'), vector);
  })().catch(error => logger.debug('HTTP', 'Background memory indexing deferred', { id }, error instanceof Error ? error : undefined));
}

async function findNearDuplicate(
  dbManager: DatabaseManager,
  project: string,
  input: SaveMemoryInput,
  embedder: Embedder,
): Promise<{ id: number; lesson: string; similarity: number } | null> {
  try {
    const index = new SQLiteVecIndex(dbManager.getConnection(), embedder.modelId, embedder.dims);
    dbManager.getConnection().run(`CREATE TABLE IF NOT EXISTS invalidated_observations (
      observation_id INTEGER PRIMARY KEY, reason TEXT, replaced_by INTEGER, invalidated_at_epoch INTEGER NOT NULL
    )`);
    const rows = dbManager.getConnection().query(`SELECT o.id, o.title, o.narrative FROM observations o
      WHERE o.project = ? AND NOT EXISTS (
        SELECT 1 FROM invalidated_observations i WHERE i.observation_id = o.id
      ) ORDER BY o.id`).all(project) as Array<{ id: number; title: string; narrative: string }>;
    if (rows.length === 0) return null;
    const candidates = rows.map(row => {
      const text = [row.title, row.narrative].filter(Boolean).join('\n');
      return { ...row, key: `observations:${row.id}`, text,
        hash: createHash('sha256').update(text).digest('hex') };
    });
    const pending = candidates.filter(candidate => !index.has(candidate.key, candidate.hash));
    for (let start = 0; start < pending.length; start += 8) {
      const batch = pending.slice(start, start + 8);
      const vectors = await embedder.embed(batch.map(item => item.text), 'passage');
      if (vectors.length !== batch.length) throw new Error('Incomplete duplicate-guard embedding batch');
      for (let offset = 0; offset < batch.length; offset++) index.put(batch[offset].key, batch[offset].hash, vectors[offset]);
    }
    const { title, narrative } = buildMemoryContent(input);
    const [query] = await embedder.embed([[title, narrative].filter(Boolean).join('\n')], 'passage');
    if (!query) throw new Error('Missing duplicate-guard query embedding');
    const threshold = Number(process.env.KIOKU_DUPLICATE_SIMILARITY ?? 0.88);
    const nearest = index.nearest(query, candidates.map(candidate => candidate.key), 1)[0];
    if (!nearest) return null;
    const similarity = 1 - nearest.distance;
    if (similarity < (Number.isFinite(threshold) ? threshold : 0.88)) return null;
    const existing = rows.find(row => `observations:${row.id}` === nearest.key);
    if (!existing) return null;
    const lesson = existing.narrative.match(/^Lesson:\s*(.+)$/m)?.[1] ?? existing.narrative;
    return { id: existing.id, lesson, similarity };
  } catch (error) {
    logger.warn('HTTP', 'Near-duplicate guard unavailable; saving memory', { project }, error instanceof Error ? error : undefined);
    return null;
  }
}

/** Shared by explicit MCP notes and the opt-in file bridge; no LLM call. */
export function saveMemory(dbManager: DatabaseManager, defaultProject: string, input: SaveMemoryInput) {
  const persist = () => persistMemory(dbManager, defaultProject, input);
  // Take the write lock before replay and supersede lookups, including across processes.
  return typeof input.metadata?.sourceFingerprint === 'string' || input.supersedes !== undefined
    ? dbManager.getConnection().transaction(persist).immediate()
    : persist();
}

function persistMemory(dbManager: DatabaseManager, defaultProject: string, input: SaveMemoryInput) {
  const { text, title, cause, lesson, narrative } = buildMemoryContent(input);
  const { metadata } = input;
  const project = resolveProject(defaultProject, input);
  const platformSource = typeof metadata?.platformSource === 'string' ? metadata.platformSource : undefined;
  const sourceFingerprint = typeof metadata?.sourceFingerprint === 'string' ? metadata.sourceFingerprint : undefined;
  if (sourceFingerprint) {
    // Exact replay dedupe includes the project and source. It survives process crashes
    // between committing a note and saving the watcher's local checkpoint.
    const existing = dbManager.getConnection().query(`SELECT o.id, o.title FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.project = ? AND COALESCE(NULLIF(s.platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?
        AND CASE WHEN json_valid(o.metadata) THEN json_extract(o.metadata, '$.sourceFingerprint') END = ?
      ORDER BY o.id DESC LIMIT 1`).get(project, normalizePlatformSource(platformSource), sourceFingerprint) as { id: number; title: string } | null;
    if (existing) return { success: true, id: existing.id, title: existing.title, project, duplicate: true, message: `Memory already saved as observation #${existing.id}` };
  }
  const store = dbManager.getSessionStore();
  const sessionId = store.getOrCreateManualSession(project, platformSource);
  const concepts = [...(lesson ? [LESSON_CONCEPT] : []), ...(input.outcome ? [memoryOutcomeConcept(input.outcome)] : [])];
  const observation = {
    type: 'discovery', title,
    subtitle: 'Manual memory', facts: [] as string[], narrative, concepts,
    files_read: [] as string[], files_modified: [] as string[], metadata: metadata ? JSON.stringify(metadata) : null,
  };
  // A person can reuse a note title while changing its facts. Keep exact
  // content replay detection, but never discard an explicit save by title.
  const result = store.storeObservation(sessionId, project, observation, 0, 0, undefined, undefined, { skipTitleDedup: true });
  logger.info('HTTP', 'Manual observation saved', { id: result.id, project, title: observation.title });
  dbManager.getCloudSync()?.notify();
  notifyGrokBotIndex();
  // A merged row keeps its original text and vector; never index the proposed
  // replacement content under the existing id.
  if (!result.mergedIntoExisting) dbManager.getChromaSync()?.syncObservation(result.id, sessionId, project, observation, 0, result.createdAtEpoch, platformSource).catch(error => {
      logChromaWriteFailure('CHROMA', 'Manual memory sync failed', { id: result.id }, error);
    });
  if (!result.mergedIntoExisting) notifyNotion({ observations: [observation], observationIds: [result.id], project, memorySessionId: sessionId, createdAtEpoch: result.createdAtEpoch });
  if (input.supersedes !== undefined) {
    const replacement = invalidateMemory(dbManager.getConnection(), {
      id: input.supersedes,
      reason: `Superseded by observation #${result.id}`,
      replacedBy: result.id,
    });
    if (!replacement.success) throw new Error(replacement.message);
  }
  return { success: true, id: result.id, title: observation.title, project,
    ...(input.supersedes !== undefined ? { superseded: input.supersedes } : {}),
    message: result.mergedIntoExisting ? `Memory matches existing observation #${result.id} (counted as a repeat)` : `Memory saved as observation #${result.id}` };
}
