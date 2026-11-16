import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { SessionSearch } from '../sqlite/SessionSearch.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import type { SearchOptions } from '../sqlite/types.js';
import { SQLiteSearchStrategy } from '../worker/search/strategies/SQLiteSearchStrategy.js';
import { isCategoryRequested, SEARCH_CATEGORIES, type SearchCategory, type SearchResult,
  type SearchResults, type StrategySearchOptions, type StrategySearchResult } from '../worker/search/types.js';
import { logger } from '../../utils/logger.js';
import type { Embedder } from './types.js';
import { SQLiteVecIndex } from './SQLiteVecIndex.js';
import { LocalEmbedder } from './LocalEmbedder.js';
import { LOCAL_EMBEDDING_MODEL } from './models.js';

export function createLocalVectorSearch(searcher: SessionSearch, store: SessionStore): SQLiteVecSearch | null {
  if (process.env.KIOKU_SQLITE_VEC_ENABLED !== 'true') return null;
  try {
    return new SQLiteVecSearch(searcher, store, new LocalEmbedder(LOCAL_EMBEDDING_MODEL, 2));
  } catch (error) {
    logger.warn('SEARCH', 'Local vector index unavailable; keeping keyword search', {}, error instanceof Error ? error : undefined);
    return null;
  }
}

const TEXT_FIELDS: Record<SearchCategory, string[]> = {
  observations: ['title', 'subtitle', 'text', 'narrative', 'facts', 'concepts', 'files_read', 'files_modified'],
  sessions: ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'],
  prompts: ['prompt_text'],
};

export class SQLiteVecSearch {
  private readonly index: SQLiteVecIndex;
  private readonly keywords: SQLiteSearchStrategy;

  constructor(private readonly searcher: SessionSearch, private readonly store: SessionStore, private readonly embedder: Embedder) {
    this.index = new SQLiteVecIndex(store.db, embedder.modelId, embedder.dims);
    this.keywords = new SQLiteSearchStrategy(searcher);
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    if (!options.query?.trim()) return this.keywords.search(options);
    const offset = Number(options.offset ?? 0);
    const limit = Number(options.limit ?? 20);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Invalid search pagination');
    }
    const keywordOptions = { ...options, offset: 0, limit: offset + limit };
    const keyword = await this.keywords.search(keywordOptions);
    const results: SearchResults = { observations: [], sessions: [], prompts: [] };
    let semantic = false;
    try {
      for (const [category, table] of [['observations', 'observations'], ['sessions', 'session_summaries'], ['prompts', 'user_prompts']]) {
        this.store.db.query(`DELETE FROM local_vectors WHERE key LIKE ? AND NOT EXISTS
          (SELECT 1 FROM ${table} WHERE id = CAST(substr(local_vectors.key, instr(local_vectors.key, ':') + 1) AS INTEGER))`)
          .run(`${category}:%`);
      }
      const candidates = this.candidates(options);
      const pending = candidates.filter(item => !this.index.has(item.key, item.hash));
      for (let start = 0; start < pending.length; start += 8) {
        const batch = pending.slice(start, start + 8);
        const vectors = await this.embedder.embed(batch.map(item => item.text), 'passage');
        if (vectors.length !== batch.length) throw new Error('Incomplete embedding batch');
        for (let index = 0; index < batch.length; index++) this.index.put(batch[index].key, batch[index].hash, vectors[index]);
        logger.debug('SEARCH', 'Local vector index progress', { indexed: Math.min(start + 8, pending.length), total: pending.length });
        await setImmediate();
      }
      const [query] = await this.embedder.embed([options.query], 'query');
      if (!query) throw new Error('Missing query embedding');
      const current = this.candidates(options);
      const eligible = current.filter(item => this.index.has(item.key, item.hash));
      for (const category of SEARCH_CATEGORIES) {
        const items = eligible.filter(item => item.category === category);
        const byKey = new Map(items.map(item => [item.key, item.row]));
        const nearest = this.index.nearest(query, [...byKey.keys()], offset + limit);
        const scores = new Map<number, number>();
        const rows = new Map<number, SearchResult>();
        for (const [rank, hit] of nearest.entries()) {
          const row = byKey.get(hit.key)!;
          rows.set(row.id, row);
          scores.set(row.id, 1 / (60 + rank + 1));
        }
        const currentIds = new Set(current.filter(item => item.category === category).map(item => item.row.id));
        for (const [rank, row] of keyword.results[category].entries()) {
          if (!currentIds.has(row.id)) continue;
          rows.set(row.id, byKey.get(`${category}:${row.id}`) ?? row);
          scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + rank + 1));
        }
        const ranked = [...rows.values()].sort((left, right) => {
          if (options.orderBy === 'date_asc') return left.created_at_epoch - right.created_at_epoch || left.id - right.id;
          if (options.orderBy === 'date_desc') return right.created_at_epoch - left.created_at_epoch || right.id - left.id;
          return scores.get(right.id)! - scores.get(left.id)! || left.id - right.id;
        });
        this.setCategory(results, category, ranked.slice(offset, offset + limit));
      }
      semantic = true;
    } catch (error) {
      logger.warn('SEARCH', 'Local vector search unavailable; using keyword search', {}, error instanceof Error ? error : undefined);
      const fallback = await this.keywords.search(keywordOptions);
      for (const category of SEARCH_CATEGORIES) this.setCategory(results, category, fallback.results[category].slice(offset, offset + limit));
    }
    return { results, usedChroma: false, strategy: semantic ? 'hybrid' : 'sqlite' };
  }

  private setCategory<Category extends SearchCategory>(results: SearchResults, category: Category, rows: SearchResult[]): void {
    results[category] = rows as SearchResults[Category];
  }

  private candidates(options: StrategySearchOptions) {
    const candidates: Array<{ key: string; category: SearchCategory; row: SearchResult; text: string; hash: string }> = [];
    for (const category of SEARCH_CATEGORIES) {
      if (!isCategoryRequested(options.searchType, category)) continue;
      const filters: SearchOptions = { ...options, type: options.obsType as SearchOptions['type'],
        dateRange: options.dateRange ?? { start: 0 }, orderBy: 'date_asc', limit: 256, offset: 0 };
      for (;;) {
        const rows: SearchResult[] = category === 'observations' ? this.searcher.searchObservations(undefined, filters)
          : category === 'sessions' ? this.searcher.searchSessions(undefined, filters)
            : this.searcher.searchUserPrompts(undefined, filters);
        for (const row of rows) {
          const fields = row as unknown as Record<string, unknown>;
          const text = TEXT_FIELDS[category].map(field => fields[field]).filter(value => typeof value === 'string').join('\n');
          candidates.push({ key: `${category}:${row.id}`, category, row, text,
            hash: createHash('sha256').update(text).digest('hex') });
        }
        if (rows.length < 256) break;
        filters.offset! += rows.length;
      }
    }
    return candidates;
  }
}