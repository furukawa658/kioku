import { describe, it, expect } from 'bun:test';
import type { WorkStateEntry, WorkStateFields } from '../../../src/services/sqlite/work-state.js';
import {
  renderWorkStateReadText,
  WORK_STATE_STALE_AFTER_MS,
} from '../../../src/services/context/sections/WorkStateRenderer.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
let id = 1;
const entry = (list: string, fields: WorkStateFields, ageMs: number): WorkStateEntry =>
  ({ id: id++, project: 'acme', list_name: list, fields, created_at_epoch: NOW - ageMs });

describe('work_state_read folds lists that have gone quiet', () => {
  const entries = [
    entry('old-plan', { task: 'a', status: 'todo' }, 40 * DAY),
    entry('old-plan', { task: 'b', status: 'doing' }, 30 * DAY),
    entry('old-done', { task: 'c', status: 'done' }, 60 * DAY),
    entry('release', { task: 'publish', status: 'doing' }, 1 * DAY),
  ];

  it('shows recent lists in full and names the quiet ones on one line', () => {
    const text = renderWorkStateReadText(entries, NOW, { includeClosed: false, includeStale: false })!;
    expect(text).toContain('- release');
    expect(text).toContain('publish');
    expect(text).not.toContain('  - [todo] a');
    expect(text).toMatch(/1 list not updated for 14\+ days is folded: old-plan \(2 open, updated about 30 days ago\)/);
    expect(text).toContain('includeStale=true');
    expect(text).not.toContain('old-done');
  });

  it('shows every list with includeStale', () => {
    const text = renderWorkStateReadText(entries, NOW, { includeClosed: false, includeStale: true })!;
    expect(text).toContain('  - [todo] a');
    expect(text).not.toContain('folded');
  });

  it('says so when only quiet lists are open', () => {
    const text = renderWorkStateReadText(entries.slice(0, 2), NOW, { includeClosed: false, includeStale: false })!;
    expect(text).toContain('Nothing updated in the last 14 days is open.');
    expect(text).toContain('old-plan');
  });

  it('returns null when nothing is open at all', () => {
    expect(renderWorkStateReadText([entries[2]], NOW, { includeClosed: false, includeStale: false })).toBeNull();
    expect(WORK_STATE_STALE_AFTER_MS).toBe(14 * DAY);
  });
});
