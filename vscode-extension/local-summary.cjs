const { normalizeLanguage } = require('./language.cjs');

const TEXTS = {
  en: {
    factsHeading: 'Facts (excerpted from the original)',
    bodyHeading: 'Body (excerpt from the beginning)',
    omitted: 'Some content was omitted. Check the original text for the full conditions and exceptions.',
    model: 'Script summary (excerpt of the original; no AI credits used)',
    error: 'There is no text to summarize.'
  },
  ja: {
    factsHeading: '事実（原文から抜粋）',
    bodyHeading: '本文（冒頭から抜粋）',
    omitted: '省略があります。条件・例外を含む全文は、元の本文で確認してください。',
    model: 'スクリプト要約（原文の抜粋・AIクレジット消費なし）',
    error: '要約する本文がありません。'
  }
};

function summarizeLocally(row, language) {
  const lang = normalizeLanguage(language);
  const t = TEXTS[lang];
  let omitted = false;
  const clip = (value, limit) => {
    if (typeof value !== 'string') return '';
    const characters = Array.from(value.trim());
    if (characters.length > limit) omitted = true;
    return characters.slice(0, limit).join('') + (characters.length > limit ? '…' : '');
  };
  let facts = row.facts;
  if (typeof facts === 'string') {
    try { facts = JSON.parse(facts); } catch { facts = [facts]; }
  }
  if (!Array.isArray(facts)) facts = [];
  facts = [...new Set(facts.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  if (facts.length > 6) omitted = true;
  const selectedFacts = facts.slice(0, 6).map(value => clip(value, 200));
  const narrative = clip(row.narrative, 1200);
  const subtitle = clip(row.subtitle, 300);
  if (!narrative && !subtitle && !selectedFacts.length) throw new Error(t.error);
  const title = clip(row.title, 200);
  const parts = [
    title,
    subtitle,
    selectedFacts.length ? `${t.factsHeading}\n${selectedFacts.map(value => `- ${value}`).join('\n')}` : '',
    narrative ? `${t.bodyHeading}\n${narrative}` : '',
    omitted ? t.omitted : ''
  ];
  return { text: parts.filter(Boolean).join('\n\n'), model: t.model };
}

module.exports = { summarizeLocally };