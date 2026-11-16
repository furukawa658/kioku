import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('sidebar search, filters, plain-text detail, stale replies, empty and error states', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const brain = (await readFile(new URL('../media/brain.png', import.meta.url))).toString('base64');
    const html = (await readFile(new URL('../media/sidebar.html', import.meta.url), 'utf8'))
      .replaceAll('{{language}}', 'en')
      .replace('{{brain}}', `data:image/png;base64,${brain}`)
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '')
      .replace(/<link[^>]+>/, '')
      .replace(/<script[^>]+><\/script>/, '')
      .replace(/src="\{\{[^}]+\}\}"/g, 'src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"');
    await page.setContent(html);
    await page.addStyleTag({ content: await readFile(new URL('../media/sidebar.css', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: message => window.sent.push(message) });
    });
    await page.addScriptTag({ content: await readFile(new URL('../media/sidebar.js', import.meta.url), 'utf8') });
    const reply = async (type, response) => page.evaluate(({ type, response }) => {
      const request = window.sent.findLast(item => item.type === type);
      window.postMessage({ type, requestId: request.requestId, ...response }, '*');
    }, { type, response });
    await reply('overview', { data: { count: 24, version: '0.3.0', workerVersion: '15.16.0', projects: ['kioku', 'A/B'] } });
    await page.getByText('Connected · 24 memories · v0.3.0').waitFor();
    assert.equal(await page.locator('#connection').getAttribute('title'), 'kioku v0.3.0 · worker v15.16.0');
    assert.equal(await page.locator('.brand-icon').evaluate(image => image.complete && image.naturalWidth > 0), true);

    const englishUiText = (await page.locator('body').innerText()).replaceAll('日本語', '');
    assert.doesNotMatch(englishUiText, /[\u3040-\u30ff\u4e00-\u9fff]/);

    await page.locator('#language').selectOption('ja');
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'setLanguage', language: 'ja' });
    await page.getByText('接続済み · 24件 · v0.3.0').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');

    await page.evaluate(() => window.postMessage({ type: 'languageChanged', data: { language: 'en' } }, '*'));
    await page.getByText('Connected · 24 memories · v0.3.0').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator('#language').inputValue(), 'en');

    if (process.env.KIOKU_TEST_SCREENSHOT) {
      await page.addStyleTag({ content: ':root { --vscode-foreground:#d8e7e8; --vscode-sideBar-background:#002b36; --vscode-descriptionForeground:#aac7ce; --vscode-input-background:#073642; --vscode-input-foreground:#e0eeee; --vscode-dropdown-background:#073642; --vscode-dropdown-foreground:#e0eeee; --vscode-panel-border:#36575e; --vscode-button-background:#176a79; --vscode-button-foreground:white; --vscode-font-size:13px; --vscode-font-family:"Noto Sans JP",sans-serif; }' });
      await page.screenshot({ path: process.env.KIOKU_TEST_SCREENSHOT });
    }
    await page.locator('#query').fill('memory');
    await page.locator('#project').selectOption('A/B');
    await page.locator('#date-start').fill('2026-11-01');
    await page.locator('#date-end').fill('2026-11-11');
    await page.locator('#query').press('Enter');
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1).input), { query: 'memory', project: 'A/B', dateStart: '2026-11-01', dateEnd: '2026-11-11' });
    await reply('search', { data: [{ id: 1, title: '<script>window.injected=true</script>', project: 'A/B', created_at: '2026-11-11T00:00:00Z' }, { id: 2, title: 'Next memory', project: 'kioku' }] });
    await page.getByText('Results: 2', { exact: true }).waitFor();
    await page.locator('.result').first().click();
    const stale = await page.evaluate(() => window.sent.at(-1));
    await page.locator('.result').nth(1).click();
    await reply('detail', { data: { id: 2, title: 'Next memory', project: 'kioku', narrative: '<img src=x onerror=alert(1)>', facts: '["Keep conditions"]' } });
    await page.locator('#detail-body').filter({ hasText: 'Keep conditions' }).waitFor();
    await page.evaluate(stale => window.postMessage({ type: 'detail', requestId: stale.requestId, data: { id: 1, narrative: 'Old body' } }, '*'), stale);
    assert.match(await page.locator('#detail-body').textContent(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('#detail-body img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('.result[aria-current=true]').count(), 1);
    await reply('copilotState', { data: { enabled: false } });
    assert.equal(await page.getByRole('switch').isChecked(), false);
    assert.equal(await page.locator('#summarize').isDisabled(), false);
    assert.match(await page.locator('#copilot-help').innerText(), /Off by default/);
    assert.match(await page.locator('#copilot-help').innerText(), /consumes no AI credits/);
    assert.match(await page.locator('#copilot-help').innerText(), /The original memory is not changed/);
    await page.getByRole('button', { name: 'Summarize with script', exact: true }).click();
    await reply('summarize', { data: { text: 'Excerpt from original', model: 'Script summary' } });
    await page.locator('#summary-text').filter({ hasText: 'Excerpt from original' }).waitFor();
    const sentBeforeEnabling = await page.evaluate(() => window.sent.filter(item => item.type === 'summarize').length);
    await page.getByRole('switch').check();
    assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'setCopilot');
    assert.equal(await page.evaluate(() => window.sent.filter(item => item.type === 'summarize').length), sentBeforeEnabling);
    await reply('setCopilot', { data: { enabled: true } });
    await page.locator('#copilot-state').filter({ hasText: 'ON' }).waitFor();
    await page.locator('#summarize').click();
    assert.equal(await page.evaluate(() => window.sent.at(-1).id), 2);
    await reply('summarize', { data: { model: 'Copilot test', text: '<img src=x onerror=alert(1)>summary' } });
    await page.locator('#summary-text').filter({ hasText: 'summary' }).waitFor();
    assert.equal(await page.locator('#summary-text img').count(), 0);
    await page.locator('#summarize').click();
    const lateSummary = await page.evaluate(() => window.sent.at(-1));
    await page.getByRole('switch').uncheck();
    assert.equal(await page.locator('#ai-summary').isHidden(), true);
    assert.equal(await page.locator('#summarize').isDisabled(), true);
    await reply('setCopilot', { data: { enabled: false } });
    await page.getByRole('button', { name: 'Summarize with script', exact: true }).waitFor();
    await page.evaluate(message => window.postMessage({ type: 'summarize', requestId: message.requestId, data: { text: 'Late summary', model: 'test' } }, '*'), lateSummary);
    assert.equal(await page.locator('#ai-summary').isHidden(), true);
    for (const width of [220, 320, 600]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    }
    if (process.env.KIOKU_SCREENSHOT) {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.screenshot({ path: process.env.KIOKU_SCREENSHOT, fullPage: true });
    }
    await page.locator('#close-detail').click();
    assert.equal(await page.locator('#detail').isHidden(), true);
    await page.locator('#query').press('Enter');
    await reply('search', { data: [] });
    await page.getByText('No matching memories').waitFor();
    await page.locator('#query').press('Enter');
    await reply('search', { error: 'worker returned HTTP 503.' });
    await page.getByRole('alert').filter({ hasText: '503' }).waitFor();
    await page.locator('#refresh').click();
    await reply('overview', { error: 'fetch failed' });
    await page.getByText('Not connected', { exact: true }).waitFor();
    await page.locator('#settings').click();
    assert.equal(await page.evaluate(() => window.sent.at(-1).type), 'settings');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});