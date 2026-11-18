import type { Database } from 'bun:sqlite';

export interface InvalidateMemoryInput {
  id: number;
  reason?: string;
  replacedBy?: number;
  restore?: boolean;
}

export interface InvalidateMemoryResult {
  success: boolean;
  id: number;
  invalidated: boolean;
  message: string;
}

/** Marks an observation as no longer valid so search skips it; the row itself is kept. */
export function invalidateMemory(db: Database, input: InvalidateMemoryInput): InvalidateMemoryResult {
  const { id, reason, replacedBy, restore } = input;
  db.run(`CREATE TABLE IF NOT EXISTS invalidated_observations (
    observation_id INTEGER PRIMARY KEY, reason TEXT, replaced_by INTEGER, invalidated_at_epoch INTEGER NOT NULL
  )`);
  if (!db.query('SELECT 1 FROM observations WHERE id = ?').get(id)) {
    return { success: false, id, invalidated: false, message: `Observation #${id} not found` };
  }
  if (restore) {
    db.query('DELETE FROM invalidated_observations WHERE observation_id = ?').run(id);
    return { success: true, id, invalidated: false, message: `Observation #${id} is searchable again` };
  }
  if (replacedBy !== undefined && replacedBy !== id
    && !db.query('SELECT 1 FROM observations WHERE id = ?').get(replacedBy)) {
    return { success: false, id, invalidated: false, message: `Replacement observation #${replacedBy} not found` };
  }
  db.query(`INSERT INTO invalidated_observations (observation_id, reason, replaced_by, invalidated_at_epoch)
    VALUES (?, ?, ?, ?) ON CONFLICT(observation_id) DO UPDATE SET reason = excluded.reason,
    replaced_by = excluded.replaced_by, invalidated_at_epoch = excluded.invalidated_at_epoch`)
    .run(id, reason?.trim() || null, replacedBy ?? null, Date.now());
  return { success: true, id, invalidated: true, message: `Observation #${id} no longer appears in search results` };
}
