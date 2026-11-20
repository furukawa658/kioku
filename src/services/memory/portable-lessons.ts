import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { MemoryOutcome } from '../../shared/memory-lesson.js';
import { MEMORY_OUTCOMES, memoryOutcomeConcept } from '../../shared/memory-lesson.js';
import type { SaveMemoryInput } from './save-memory.js';

export type LessonPortableFormat = 'jsonl' | 'markdown';

export interface PortableLesson {
  version: 1;
  kind: 'kioku.lesson';
  project: string;
  title: string;
  text: string;
  outcome?: MemoryOutcome;
  cause?: string;
  lesson?: string;
  metadata?: Record<string, unknown>;
}

export function memoryFieldsFromNarrative(narrative: string) {
  const marker = narrative.search(/\n\n(?:Outcome: |Cause: |Lesson: )/);
  const text = (marker < 0 ? narrative : narrative.slice(0, marker)).trim();
  const fields = marker < 0 ? '' : narrative.slice(marker + 2);
  return {
    text,
    cause: fields.match(/^Cause:\s*(.*)$/m)?.[1]?.trim() || undefined,
    lesson: fields.match(/^Lesson:\s*(.*)$/m)?.[1]?.trim() || undefined,
  };
}

export function exportProjectLessons(db: Database, project: string, format: LessonPortableFormat): string {
  const rows = db.query(`SELECT o.id, o.title, o.narrative, o.metadata, o.concepts
    FROM observations o
    WHERE o.project = ? AND json_valid(o.concepts)
      AND EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = 'lesson')
    ORDER BY o.id`).all(project) as Array<{
      id: number; title: string; narrative: string; metadata: string | null; concepts: string;
    }>;
  const hasInvalidations = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invalidated_observations'").get();
  const invalidated = hasInvalidations ? new Set((db.query('SELECT observation_id FROM invalidated_observations').all() as Array<{ observation_id: number }>).map(row => row.observation_id)) : new Set<number>();
  const records = rows.filter(row => !invalidated.has(row.id)).map(row => {
    const concepts = JSON.parse(row.concepts) as string[];
    const outcome = MEMORY_OUTCOMES.find(candidate => concepts.includes(memoryOutcomeConcept(candidate)));
    let metadata: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(row.metadata ?? 'null');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch { /* Legacy malformed metadata is omitted from portable output. */ }
    return {
      version: 1, kind: 'kioku.lesson', project, title: row.title,
      ...memoryFieldsFromNarrative(row.narrative),
      ...(outcome ? { outcome } : {}), ...(metadata ? { metadata } : {}),
    } satisfies PortableLesson;
  });
  if (format === 'jsonl') return records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
  const body = records.map(record => `## ${record.title}\n\n${record.text}${record.cause ? `\n\n### Cause\n\n${record.cause}` : ''}${record.lesson ? `\n\n### Lesson\n\n${record.lesson}` : ''}\n\n<!-- kioku-memory:${JSON.stringify(record)} -->`).join('\n\n');
  return `# kioku lessons: ${project}\n${body ? `\n${body}\n` : ''}`;
}

export function parsePortableLessons(data: string, format: LessonPortableFormat, defaultProject?: string): PortableLesson[] {
  const candidates = format === 'jsonl'
    ? data.split(/\r?\n/).filter(line => line.trim())
    : [...data.matchAll(/<!-- kioku-memory:(.*?) -->/gs)].map(match => match[1]);
  return candidates.map(candidate => {
    const value = JSON.parse(format === 'jsonl' ? candidate : candidate.trim()) as PortableLesson;
    if (value?.version !== 1 || value.kind !== 'kioku.lesson' || typeof value.title !== 'string' || typeof value.text !== 'string') {
      throw new Error('Invalid kioku lesson record');
    }
    if (defaultProject && value.project !== defaultProject) throw new Error('Imported project does not match the requested project');
    if (value.outcome !== undefined && !MEMORY_OUTCOMES.includes(value.outcome)) throw new Error('Invalid lesson outcome');
    return value;
  });
}

export function portableLessonInput(record: PortableLesson, project: string): SaveMemoryInput {
  const fingerprint = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  return {
    project, title: record.title, text: record.text, outcome: record.outcome,
    cause: record.cause, lesson: record.lesson,
    metadata: { ...record.metadata, source: 'kioku-import', sourceFingerprint: fingerprint },
  };
}
