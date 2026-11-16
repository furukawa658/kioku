import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { summarizeLocally } = require('../local-summary.cjs');

test('script summary extracts local text and preserves negation without network access', () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network access is forbidden'); };
  try {
    const row = { title: 'Data preservation', narrative: 'Do not drop the DB. Only drop legacy code.', facts: '["DB is preserved","DB is preserved"]' };
    const result = summarizeLocally(row);
    assert.match(result.text, /Do not drop the DB\. Only drop legacy code\./);
    assert.equal(result.text.split('- DB is preserved').length - 1, 1);
    assert.match(result.model, /no AI credits used/);
    assert.deepEqual(summarizeLocally(row), result);
  } finally {
    globalThis.fetch = previous;
  }
});

test('script summary bounds output and discloses omissions', () => {
  const result = summarizeLocally({ narrative: 'text'.repeat(10000), facts: Array.from({ length: 10 }, (_, index) => `fact${index}`) });
  assert.ok(result.text.length < 2000);
  assert.match(result.text, /Some content was omitted/);
  assert.doesNotMatch(result.text, /fact6/);
});

test('empty bodies are not fabricated and plain-text facts are supported', () => {
  assert.throws(() => summarizeLocally({ title: 'Title only' }), /There is no text to summarize\./);
  assert.match(summarizeLocally({ facts: 'Original fact' }).text, /Original fact/);
});

test('script summary in Japanese uses Japanese headings, model label and omissions note', () => {
  const row = {
    title: 'データ保持',
    narrative: 'DBを削除しない。ただし旧プログラムだけを削除する。',
    facts: '["DBは保持する","DBは保持する"]'
  };
  const result = summarizeLocally(row, 'ja');
  assert.match(result.text, /事実（原文から抜粋）/);
  assert.match(result.text, /本文（冒頭から抜粋）/);
  assert.match(result.text, /DBを削除しない。ただし旧プログラムだけを削除する。/);
  assert.equal(result.text.split('- DBは保持する').length - 1, 1);
  assert.equal(result.model, 'スクリプト要約（原文の抜粋・AIクレジット消費なし）');

  const omittedResult = summarizeLocally({ narrative: '記憶'.repeat(10000), facts: Array.from({ length: 10 }, (_, index) => `事実${index}`) }, 'ja');
  assert.match(omittedResult.text, /省略があります。条件・例外を含む全文は、元の本文で確認してください。/);

  assert.throws(() => summarizeLocally({ title: '題名のみ' }, 'ja'), /要約する本文がありません。/);
});