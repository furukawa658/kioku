(() => {
  const vscode = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  const pending = new Map();
  let sequence = 0;
  let selectedId;
  let detailLoaded = false;
  let copilotEnabled = false;
  let copilotReady = false;
  let lastRows = null;
  let lastDetailRow = null;
  let lastOverviewData = null;

  const MESSAGES = {
    en: {
      connectionChecking: 'Checking connection',
      connected: 'Connected · {count} memories · v{version}',
      disconnected: 'Not connected',
      overviewErrorHint: '{error} Check that the worker is running and the connection setting is correct, then refresh.',
      refreshTitle: 'Refresh connection status and projects',
      settingsTitle: 'Connection settings',
      languageLabel: 'Language',
      summaryMethodHeading: 'Summary method',
      copilotSwitch: 'Summarize with Copilot',
      copilotHelp1: 'Off by default. When off, a script on this PC makes an extractive summary from the original text. No external AI is used and this summary feature consumes no AI credits.',
      copilotHelp2: 'When on, GitHub Copilot is used. The title, body and facts of the selected memory are sent only when you press the summarize button in the detail pane, confirm, and choose a model. Switching this on sends nothing. The original memory is not changed.',
      copilotHelp3: 'When on, you must be signed in to Copilot. Some models consume usage quota. Terms of use and data handling follow your plan and your organization\'s policies.',
      savingSetting: 'Saving setting',
      settingFailed: 'Could not read or save the setting.',
      copilotOnStatus: 'Copilot is on. Summarize from the detail pane.',
      copilotOffStatus: 'Using script summaries (no credits used).',
      queryLabel: 'Search terms',
      searchTitle: 'Search',
      projectLabel: 'Project',
      allProjects: 'All',
      dateStart: 'Start date',
      dateEnd: 'End date',
      resultsHeading: 'Results',
      notSearched: 'No search yet',
      searching: 'Searching',
      searchFailed: 'Search failed',
      resultCount: 'Results: {count}',
      resultCountLimit: 'Results: {count} (limit 50)',
      noResults: 'No matching memories',
      memoryFallback: 'Memory #{id}',
      detailHeading: 'Detail',
      closeDetail: 'Close detail',
      loadingDetail: 'Loading detail',
      detailFailed: 'Could not load detail',
      summarizeScript: 'Summarize with script',
      summarizeCopilot: 'Summarize with Copilot',
      summarizeScriptTitle: 'Summarize the selected memory with the script',
      summarizeCopilotTitle: 'Summarize the selected memory with Copilot',
      summaryWaitingCopilot: 'Waiting for confirmation and summary',
      summaryRunningScript: 'Summarizing with the script (no credits used)',
      summaryFailed: 'Could not complete the summary.',
      summaryDone: 'Summary complete.',
      summaryHeading: 'Summary'
    },
    ja: {
      connectionChecking: '接続確認中',
      connected: '接続済み · {count}件 · v{version}',
      disconnected: '未接続',
      overviewErrorHint: '{error} workerの起動状態と接続設定を確認し、更新してください。',
      refreshTitle: '接続状態とプロジェクトを更新',
      settingsTitle: '接続設定',
      languageLabel: '言語',
      summaryMethodHeading: '要約の方法',
      copilotSwitch: 'Copilotで要約する',
      copilotHelp1: '既定はOFFです。OFFではPC内のスクリプトが原文を抜粋して要約します。外部AIは使わず、この要約機能でのAIクレジット消費はありません。',
      copilotHelp2: 'ONではGitHub Copilotを使います。本文欄の要約ボタンを押し、確認とモデル選択をしたときだけ、選択した記憶のタイトル・本文・事実を送信します。切替だけでは送信しません。元の記憶は変更しません。',
      copilotHelp3: 'ONの場合はCopilotへのサインインが必要です。モデルによって利用枠を消費することがあります。利用条件と情報の取扱いは、利用者の契約と組織ポリシーに従います。',
      savingSetting: '設定を保存中',
      settingFailed: '設定を取得・保存できませんでした。',
      copilotOnStatus: 'Copilot利用はONです。要約は本文欄から実行できます。',
      copilotOffStatus: 'スクリプト要約を使用します（クレジット消費なし）。',
      queryLabel: '検索語',
      searchTitle: '検索',
      projectLabel: 'プロジェクト',
      allProjects: 'すべて',
      dateStart: '開始日',
      dateEnd: '終了日',
      resultsHeading: '検索結果',
      notSearched: '未検索',
      searching: '検索中',
      searchFailed: '検索失敗',
      resultCount: '{count}件',
      resultCountLimit: '{count}件（上限50件）',
      noResults: '該当する記憶がありません',
      memoryFallback: '記憶 #{id}',
      detailHeading: '本文',
      closeDetail: '本文を閉じる',
      loadingDetail: '本文を取得中',
      detailFailed: '本文取得失敗',
      summarizeScript: 'スクリプトで要約',
      summarizeCopilot: 'Copilotで要約',
      summarizeScriptTitle: '選択した記憶をスクリプトで要約',
      summarizeCopilotTitle: '選択した記憶をCopilotで要約',
      summaryWaitingCopilot: '送信確認・要約待ち',
      summaryRunningScript: 'スクリプトで要約中（クレジット消費なし）',
      summaryFailed: '要約を完了できませんでした。',
      summaryDone: '要約が完了しました。',
      summaryHeading: '要約'
    }
  };

  let language = document.documentElement.lang === 'ja' ? 'ja' : 'en';

  function t(key, params = {}) {
    const template = MESSAGES[language]?.[key] ?? MESSAGES.en[key] ?? '';
    return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
  }

  const textMap = new Map();

  function setText(id, key, params = {}) {
    textMap.set(id, { key, params });
    const el = element(id);
    if (el) el.textContent = t(key, params);
  }

  function setRaw(id, text) {
    textMap.delete(id);
    const el = element(id);
    if (el) el.textContent = text;
  }

  const saved = vscode.getState() || {};
  for (const key of ['query', 'date-start', 'date-end']) element(key).value = saved[key] || '';

  function request(type, payload = {}) {
    const requestId = ++sequence;
    pending.set(type, requestId);
    vscode.postMessage({ type, requestId, ...payload });
  }

  function save() {
    vscode.setState(Object.fromEntries(['query', 'project', 'date-start', 'date-end'].map(key => [key, element(key).value])));
  }

  function error(message = '') {
    element('error').textContent = message;
    element('error').hidden = !message;
  }

  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
  }

  function metadata(row) {
    return [row.project, date(row.created_at), `#${row.id}`].filter(Boolean).join(' · ');
  }

  function closeDetail() {
    pending.delete('detail');
    cancelSummary();
    detailLoaded = false;
    lastDetailRow = null;
    element('summarize').disabled = true;
    element('detail').hidden = true;
    selectedId = undefined;
    for (const button of element('results').querySelectorAll('button')) button.removeAttribute('aria-current');
  }

  function renderResults(rows) {
    element('results').replaceChildren();
    setText('result-count', rows.length >= 50 ? 'resultCountLimit' : 'resultCount', { count: rows.length });
    element('empty').hidden = rows.length > 0;
    setText('empty', 'noResults');
    for (const row of rows) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'result';
      if (row.id === selectedId) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'result-title';
      title.textContent = row.title || t('memoryFallback', { id: row.id });
      const meta = document.createElement('span');
      meta.className = 'result-meta';
      meta.textContent = metadata(row);
      button.append(title, meta);
      button.addEventListener('click', () => {
        closeDetail();
        error();
        selectedId = row.id;
        button.setAttribute('aria-current', 'true');
        element('detail').hidden = false;
        setText('detail-status', 'loadingDetail');
        setRaw('detail-title', '');
        setRaw('detail-meta', '');
        setRaw('detail-body', '');
        request('detail', { id: row.id });
      });
      item.append(button);
      element('results').append(item);
    }
  }

  function showResults(rows) {
    lastRows = rows;
    renderResults(rows);
  }

  function list(value) {
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join('\n');
    if (typeof value !== 'string') return '';
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? list(parsed) : value; } catch { return value; }
  }

  function cancelSummary() {
    pending.delete('summarize');
    vscode.postMessage({ type: 'cancelSummary' });
    element('ai-summary').hidden = true;
    setRaw('summary-text', '');
    setRaw('summary-model', '');
    setRaw('summary-status', '');
  }

  function updateCopilotLabels() {
    element('copilot-enabled').checked = copilotEnabled;
    element('copilot-state').textContent = copilotEnabled ? 'ON' : 'OFF';
    setText('summary-button-text', copilotEnabled ? 'summarizeCopilot' : 'summarizeScript');
    element('summarize').title = t(copilotEnabled ? 'summarizeCopilotTitle' : 'summarizeScriptTitle');
    updateSummaryButton();
  }

  function updateCopilot(enabled) {
    if (copilotEnabled !== (enabled === true)) cancelSummary();
    copilotEnabled = enabled === true;
    updateCopilotLabels();
  }

  function updateSummaryButton() {
    element('summarize').disabled = !copilotReady || !detailLoaded || pending.has('summarize') || pending.has('setCopilot');
  }

  function applyLanguage(next) {
    language = next;
    document.documentElement.lang = language;
    if (element('language')) element('language').value = language;

    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      const text = t(el.getAttribute('data-i18n-title'));
      el.title = text;
      el.setAttribute('aria-label', text);
    }
    for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    }

    if (lastOverviewData && textMap.get('connection')?.key === 'connected') {
      const count = lastOverviewData.count.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
      textMap.set('connection', { key: 'connected', params: { count, version: lastOverviewData.version } });
      element('connection').title = `kioku v${lastOverviewData.version} · worker v${lastOverviewData.workerVersion ?? ''}`;
    }

    for (const [id, { key, params }] of textMap.entries()) {
      const el = element(id);
      if (el) el.textContent = t(key, params);
    }

    const allOption = element('project')?.querySelector('option[value=""]');
    if (allOption) allOption.textContent = t('allProjects');

    updateCopilotLabels();

    if (lastRows) renderResults(lastRows);

    if (lastDetailRow && selectedId === lastDetailRow.id && !element('detail').hidden) {
      setRaw('detail-title', lastDetailRow.title || t('memoryFallback', { id: lastDetailRow.id }));
      setRaw('detail-meta', metadata(lastDetailRow));
    }
  }

  element('language').addEventListener('change', () => {
    const value = element('language').value;
    applyLanguage(value);
    error();
    vscode.postMessage({ type: 'setLanguage', language: value });
  });

  element('copilot-enabled').addEventListener('change', () => {
    const enabled = element('copilot-enabled').checked;
    if (!enabled) updateCopilot(false);
    element('copilot-enabled').disabled = true;
    setText('copilot-setting-status', 'savingSetting');
    request('setCopilot', { enabled });
    updateSummaryButton();
  });

  element('summarize').addEventListener('click', () => {
    if (!copilotReady || !detailLoaded || pending.has('summarize') || pending.has('setCopilot')) return;
    error();
    cancelSummary();
    setText('summary-status', copilotEnabled ? 'summaryWaitingCopilot' : 'summaryRunningScript');
    element('summarize').disabled = true;
    request('summarize', { id: selectedId });
  });

  element('search-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!element('search-form').reportValidity()) return;
    save();
    error();
    closeDetail();
    element('results').replaceChildren();
    element('results').setAttribute('aria-busy', 'true');
    setText('result-count', 'searching');
    element('empty').hidden = true;
    element('search').disabled = true;
    request('search', { input: { query: element('query').value, project: element('project').value, dateStart: element('date-start').value, dateEnd: element('date-end').value } });
  });

  element('refresh').addEventListener('click', () => {
    setText('connection', 'connectionChecking');
    element('refresh').disabled = true;
    error();
    request('copilotState');
    request('overview');
  });

  element('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
  element('close-detail').addEventListener('click', closeDetail);

  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'copilotChanged') { updateCopilot(message.data.enabled); return; }
    if (message?.type === 'languageChanged') {
      if (message.data?.language && message.data.language !== language) {
        applyLanguage(message.data.language);
      }
      return;
    }
    if (!message || pending.get(message.type) !== message.requestId) return;
    pending.delete(message.type);
    if (message.type === 'copilotState' || message.type === 'setCopilot') {
      element('copilot-enabled').disabled = false;
      if (message.error) {
        copilotReady = false;
        updateCopilot(copilotEnabled);
        setText('copilot-setting-status', 'settingFailed');
        error(message.error);
        if (message.type === 'setCopilot') request('copilotState');
      } else {
        copilotReady = true;
        updateCopilot(message.data.enabled);
        setText('copilot-setting-status', copilotEnabled ? 'copilotOnStatus' : 'copilotOffStatus');
      }
    }
    if (message.type === 'overview') {
      element('refresh').disabled = false;
      if (message.error) {
        setText('connection', 'disconnected');
        error(t('overviewErrorHint', { error: message.error }));
        return;
      }
      lastOverviewData = message.data;
      const count = message.data.count.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
      setText('connection', 'connected', { count, version: message.data.version });
      element('connection').title = `kioku v${message.data.version} · worker v${message.data.workerVersion ?? ''}`;
      const selected = element('project').value || saved.project || '';
      element('project').replaceChildren(new Option(t('allProjects'), ''));
      for (const project of message.data.projects) element('project').add(new Option(project, project));
      element('project').value = message.data.projects.includes(selected) ? selected : '';
    }
    if (message.type === 'search') {
      element('search').disabled = false;
      element('results').setAttribute('aria-busy', 'false');
      if (message.error) {
        error(message.error);
        setText('result-count', 'searchFailed');
        return;
      }
      showResults(message.data);
    }
    if (message.type === 'detail') {
      if (message.error) { setText('detail-status', 'detailFailed'); error(message.error); return; }
      const row = message.data;
      if (row.id !== selectedId) return;
      detailLoaded = true;
      lastDetailRow = row;
      updateSummaryButton();
      setRaw('detail-status', '');
      setRaw('detail-title', row.title || t('memoryFallback', { id: row.id }));
      setRaw('detail-meta', metadata(row));
      setRaw('detail-body', [row.subtitle, row.narrative, list(row.facts), list(row.concepts), list(row.files_read), list(row.files_modified)].filter(Boolean).join('\n\n'));
    }
    if (message.type === 'summarize') {
      updateSummaryButton();
      if (message.error) { setText('summary-status', 'summaryFailed'); error(message.error); return; }
      if (!detailLoaded) return;
      setText('summary-status', 'summaryDone');
      setRaw('summary-model', message.data.model);
      setRaw('summary-text', message.data.text);
      element('ai-summary').hidden = false;
    }
  });

  setText('connection', 'connectionChecking');
  setText('empty', 'notSearched');
  applyLanguage(language);
  request('copilotState');
  request('overview');
})();