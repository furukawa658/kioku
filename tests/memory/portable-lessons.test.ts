import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { invalidateMemory } from '../../src/services/memory/invalidate-memory.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import { exportProjectLessons, parsePortableLessons, portableLessonInput } from '../../src/services/memory/portable-lessons.js';

function manager(store: SessionStore) {
  return { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any;
}

describe('portable lesson export and import', () => {
  it('exports only active lessons and round-trips JSONL and Markdown', () => {
    const store = new SessionStore(':memory:');
    try {
      const active = saveMemory(manager(store), 'source-project', {
        title: 'Deploy safely', text: 'The deployment failed.', outcome: 'failure',
        cause: 'Dependencies were included.', lesson: 'Pass --no-dependencies.', metadata: { package: 'vsix' },
      });
      const retired = saveMemory(manager(store), 'source-project', {
        title: 'Old deploy', text: 'The old path failed.', lesson: 'Use the old path.',
      });
      saveMemory(manager(store), 'source-project', { title: 'Plain note', text: 'Not a lesson.' });
      invalidateMemory(store.db, { id: retired.id, reason: 'Retired' });

      const jsonl = exportProjectLessons(store.db, 'source-project', 'jsonl');
      const jsonlRecords = parsePortableLessons(jsonl, 'jsonl', 'source-project');
      expect(jsonlRecords).toHaveLength(1);
      expect(jsonlRecords[0]).toMatchObject({ title: 'Deploy safely', outcome: 'failure', cause: 'Dependencies were included.', lesson: 'Pass --no-dependencies.' });

      const markdown = exportProjectLessons(store.db, 'source-project', 'markdown');
      expect(markdown).toContain('## Deploy safely');
      expect(markdown).not.toContain('Old deploy');
      expect(parsePortableLessons(markdown, 'markdown', 'source-project')).toEqual(jsonlRecords);
      expect(jsonlRecords[0].project).toBe('source-project');
      expect(jsonlRecords[0].text).toBe('The deployment failed.');
      expect(active.id).toBeGreaterThan(0);
    } finally { store.close(); }
  });

  it('imports the same portable lesson idempotently', () => {
    const source = new SessionStore(':memory:');
    const target = new SessionStore(':memory:');
    try {
      saveMemory(manager(source), 'shared-project', { title: 'Pin the version', text: 'A build changed.', lesson: 'Pin the dependency.' });
      const records = parsePortableLessons(exportProjectLessons(source.db, 'shared-project', 'jsonl'), 'jsonl', 'shared-project');
      const first = saveMemory(manager(target), 'shared-project', portableLessonInput(records[0], 'shared-project'));
      const second = saveMemory(manager(target), 'shared-project', portableLessonInput(records[0], 'shared-project'));
      expect(first.duplicate).not.toBe(true);
      expect(second).toMatchObject({ id: first.id, duplicate: true });
      expect(target.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 1 });
    } finally { source.close(); target.close(); }
  });
});
