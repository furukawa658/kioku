const LANGUAGES = ['en', 'ja'];
function normalizeLanguage(value) { return value === 'ja' ? 'ja' : 'en'; }
module.exports = { LANGUAGES, normalizeLanguage };
