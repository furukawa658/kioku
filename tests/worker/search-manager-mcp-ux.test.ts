import { describe, it, expect, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { estimateObservationReadTokens } from '../../src/services/worker/FormattingService.js';
import { assertSearchHasQueryOrFilter } from '../../src/services/worker/search/SearchOrchestrator.js';

function makeManager(observations: object[], store: object = {}): SearchManager {
  return new SearchManager(
    { searchObservations: mock(() => observations), searchSessions: mock(() => []), searchUserPrompts: mock(() => []) } as any,
    {
      getObservationsByIds: mock(() => []), getSessionSummariesByIds: mock(() => []), getUserPromptsByIds: mock(() => []),
      getProjectReadKeys: (projects: string[]) => projects, ...store,
    } as any,
    null as any,
    {
      formatSearchTableHeader: mock(() => '| h |'),
      formatObservationSearchRow: mock((obs: any) => ({ row: `| #${obs.id} |`, time: '' })),
    } as any,
    {} as any,
  );
}

function row(id: number, project: string) {
  return {
    id, memory_session_id: `s-${id}`, project, text: null, type: 'discovery', title: `t${id}`, subtitle: null,
    facts: '[]', narrative: null, concepts: '["lesson"]', files_read: '[]', files_modified: '[]', prompt_number: 1,
    discovery_tokens: 0, created_at: '2026-11-18T01:00:00.000Z', created_at_epoch: Date.parse('2026-11-18T01:00:00.000Z'),
  };
}

describe('search output for MCP callers', () => {
  it('describes a filter-only search instead of printing "undefined"', async () => {
    const result = await makeManager([row(1, 'kioku')]).search({ concepts: 'lesson', type: 'observations' });
    const text = result.content[0].text as string;
    expect(text).not.toContain('undefined');
    expect(text).toContain('Found 1 result(s) for filters: concepts=lesson');
  });

  it('describes a filter-only search with no results', async () => {
    const result = await makeManager([]).search({ concepts: 'lesson', type: 'observations' });
    const text = result.content[0].text as string;
    expect(text).not.toContain('undefined');
    expect(text).toContain('No results found for filters: concepts=lesson');
  });

  it('names the project of each group when results span projects', async () => {
    const result = await makeManager([row(1, 'kioku'), row(2, 'Doc-2025')]).search({ concepts: 'lesson', type: 'observations' });
    const text = result.content[0].text as string;
    expect(text).toContain('Projects: kioku (1), Doc-2025 (1)');
    expect(text).toContain('**General · kioku**');
    expect(text).toContain('**General · Doc-2025**');
  });

  it('keeps the plain group label for a single project', async () => {
    const result = await makeManager([row(1, 'kioku')]).search({ concepts: 'lesson', type: 'observations' });
    const text = result.content[0].text as string;
    expect(text).toContain('Project: kioku');
    expect(text).toContain('**General**');
  });

  it('lists known projects when a project-filtered search finds nothing', async () => {
    const store = { getProjectCatalog: () => ({ projects: ['kioku', 'Doc-2025'], sources: [], projectsBySource: {} }) };
    const result = await makeManager([], store).search({ query: 'release', project: 'kiokuu', type: 'observations' });
    const text = result.content[0].text as string;
    expect(text).toContain('No results found matching "release"');
    expect(text).toContain('Projects with memory: kioku, Doc-2025');
  });
});

describe('search request validation', () => {
  it('explains which arguments make a search valid', () => {
    expect(() => assertSearchHasQueryOrFilter({})).toThrow(/query text or at least one filter.*concepts/);
  });
});

describe('read-token estimate', () => {
  it('counts title, subtitle, narrative and facts', () => {
    expect(estimateObservationReadTokens({ title: 'abcd', subtitle: 'efgh', narrative: 'ijkl', facts: 'mnop' } as any)).toBe(4);
  });
});
