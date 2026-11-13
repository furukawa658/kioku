import languageModule from './language.cjs';
const { normalizeLanguage } = languageModule;

const MESSAGES = {
  en: {
    invalidWorkerUrl: 'The connection target must be the HTTP URL of a local worker.',
    httpStatus: status => `The worker returned HTTP ${status}.`,
    searchFailed: 'The worker failed to search.',
    invalidOverviewFormat: 'The worker response has an unexpected format.',
    emptyQuery: 'Enter search terms.',
    invalidDate: 'The date is invalid.',
    endBeforeStart: 'The end date must be on or after the start date.',
    invalidSearchResultFormat: 'The search result has an unexpected format.',
    invalidMemoryId: 'The memory ID is invalid.',
    invalidDetailFormat: 'The detail response has an unexpected format.'
  },
  ja: {
    invalidWorkerUrl: '接続先にはローカルworkerのHTTP URLを指定してください。',
    httpStatus: status => `workerからHTTP ${status}が返りました。`,
    searchFailed: 'workerで検索に失敗しました。',
    invalidOverviewFormat: 'workerの応答形式が想定と異なります。',
    emptyQuery: '検索語を入力してください。',
    invalidDate: '日付が正しくありません。',
    endBeforeStart: '終了日は開始日以降にしてください。',
    invalidSearchResultFormat: '検索結果の形式が想定と異なります。',
    invalidMemoryId: '記憶IDが正しくありません。',
    invalidDetailFormat: '本文の応答形式が想定と異なります。'
  }
};

export function workerUrl(value, language) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    const messages = MESSAGES[normalizeLanguage(language)];
    throw new Error(messages.invalidWorkerUrl);
  }
  return url;
}

export class KiokuClient {
  constructor(baseUrl, fetcher = fetch, language = 'en') {
    this.messages = MESSAGES[normalizeLanguage(language)];
    this.baseUrl = workerUrl(baseUrl, language);
    this.fetcher = fetcher;
  }

  async get(path, params = {}, signal) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = path === '/api/search' ? 600000 : 20000;
    const response = await this.fetcher(url, {
      method: 'GET', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    });
    if (!response.ok) throw new Error(this.messages.httpStatus(response.status));
    const body = await response.json();
    if (body?.isError) throw new Error(this.messages.searchFailed);
    return body;
  }

  async overview(signal) {
    const [stats, catalog] = await Promise.all([
      this.get('/api/stats', {}, signal), this.get('/api/projects', {}, signal)
    ]);
    if (!Number.isSafeInteger(stats?.database?.observations) || !Array.isArray(catalog?.projects)
        || !catalog.projects.every(project => typeof project === 'string')) {
      throw new Error(this.messages.invalidOverviewFormat);
    }
    return { count: stats.database.observations, version: String(stats.worker?.version ?? ''), projects: catalog.projects };
  }

  async search(input, signal) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw new Error(this.messages.emptyQuery);
    const dateStart = input.dateStart || '';
    const dateEnd = input.dateEnd || '';
    for (const value of [dateStart, dateEnd]) {
      if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))
          || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(this.messages.invalidDate);
    }
    if (dateStart && dateEnd && dateStart > dateEnd) throw new Error(this.messages.endBeforeStart);
    const result = await this.get('/api/search', {
      query, project: input.project || '', dateStart, dateEnd,
      type: 'observations', format: 'json', limit: 50
    }, signal);
    if (!Array.isArray(result?.observations) || !result.observations.every(row => Number.isSafeInteger(row?.id) && row.id > 0)) {
      throw new Error(this.messages.invalidSearchResultFormat);
    }
    return result.observations;
  }

  async observation(id, signal) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(this.messages.invalidMemoryId);
    const row = await this.get(`/api/observation/${id}`, {}, signal);
    if (row?.id !== id) throw new Error(this.messages.invalidDetailFormat);
    return row;
  }
}