import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
const require = createRequire(import.meta.url);
const { summarizeWithCopilot } = require('../copilot.cjs');

function fixture() {
  const calls = [];
  const state = { enabled: false, consent: 'Send and summarize' };
  const model = {
    name: 'Copilot test', id: 'test', maxInputTokens: 10000,
    async countTokens() { calls.push('tokens'); return 10; },
    async sendRequest(messages) {
      calls.push({ send: messages });
      return { text: (async function* () { yield 'Summary text'; })() };
    }
  };
  const api = {
    window: {
      async showWarningMessage(msg, opt, btn) { calls.push({ confirm: { msg, opt, btn } }); return state.consent; },
      async showQuickPick(items, opt) { calls.push({ choose: opt }); return items[0]; }
    },
    lm: { async selectChatModels(selector) { calls.push({ selector }); return [model]; } },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    LanguageModelChatMessage: { User: content => ({ content }) }
  };
  const options = { isEnabled: () => state.enabled, id: 1, loadObservation: async () => { calls.push('load'); return { title: 'Title', narrative: 'Body', facts: ['Fact'], files_read: ['PRIVATE_PATH_NOT_SENT'] }; } };
  return { calls, state, api, options, model };
}

test('default OFF rejects before loading memory or accessing Copilot', async () => {
  const { api, options, calls } = fixture();
  await assert.rejects(() => summarizeWithCopilot(api, options), /Copilot is off\./);
  assert.deepEqual(calls, []);
});

test('ON still requires confirmation and only sends selected fields to Copilot', async () => {
  const { api, options, calls, state } = fixture();
  state.enabled = true;
  const result = await summarizeWithCopilot(api, options);
  assert.equal(result.text, 'Summary text');
  assert.deepEqual(calls.find(call => call.selector), { selector: { vendor: 'copilot' } });
  const sent = calls.find(call => call.send).send[0].content;
  assert.match(sent, /Title/);
  assert.match(sent, /Fact/);
  assert.match(sent, /<memory_data>/);
  assert.doesNotMatch(sent, /PRIVATE_PATH/);
  assert.equal(calls.filter(call => call.send).length, 1);
});

test('cancelled consent never queries or calls a model', async () => {
  const { api, options, calls, state } = fixture();
  state.enabled = true;
  state.consent = undefined;
  await assert.rejects(() => summarizeWithCopilot(api, options), /Sending was cancelled\./);
  assert.equal(calls.filter(c => c === 'load' || c.confirm).length, 2);
});

test('turning OFF while consent is pending prevents a model call', async () => {
  const { api, options, calls, state } = fixture();
  state.enabled = true;
  api.window.showWarningMessage = async (msg, opt, btn) => { calls.push({ confirm: { msg, opt, btn } }); state.enabled = false; return 'Send and summarize'; };
  await assert.rejects(() => summarizeWithCopilot(api, options), /Copilot is off\./);
  assert.deepEqual(calls.map(c => c.confirm ? 'confirm' : c), ['load', 'confirm']);
});

test('no Copilot models is an error, never a fallback to another service', async () => {
  const { api, options, state } = fixture();
  state.enabled = true;
  api.lm.selectChatModels = async () => [];
  await assert.rejects(() => summarizeWithCopilot(api, options), /No Copilot model is available\./);
});

test('Japanese language uses Japanese error and prompt, but dialog texts stay English', async () => {
  const { api, options, calls, state } = fixture();
  state.enabled = true;
  const optionsJa = { ...options, language: 'ja' };
  const result = await summarizeWithCopilot(api, optionsJa);
  assert.equal(result.text, 'Summary text');
  const confirmCall = calls.find(call => call.confirm);
  assert.ok(confirmCall);
  assert.equal(confirmCall.confirm.msg, "The title, body and facts of the selected memory will be sent to GitHub Copilot to be summarized. Check your organization's rules before sending. The original memory is not changed.");
  assert.equal(confirmCall.confirm.btn, 'Send and summarize');
  const chooseCall = calls.find(call => call.choose);
  assert.equal(chooseCall.choose.title, 'GitHub Copilot model for the summary');
  const sent = calls.find(call => call.send).send[0].content;
  assert.match(sent, /次のデータを日本語で簡潔に要約してください/);
  assert.match(sent, /<記憶データ>/);

  state.enabled = false;
  await assert.rejects(() => summarizeWithCopilot(api, optionsJa), /Copilot利用はOFFです。/);

  state.enabled = true;
  state.consent = undefined;
  await assert.rejects(() => summarizeWithCopilot(api, optionsJa), /送信を取り消しました。/);
});

test('extension host routes OFF to the local script and enabling alone never calls Copilot', async () => {
  let provider;
  let enabled = false;
  let modelCalls = 0;
  const replies = [];
  const requests = [];
  const mock = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({
        get: (key, def) => key === 'copilotEnabled' ? enabled : (key === 'language' ? 'en' : 'http://127.0.0.1:37765'),
        update: async (key, value, target) => { assert.equal(key, 'copilotEnabled'); assert.equal(target, 1); enabled = value; }
      })
    },
    window: { registerWebviewViewProvider: (id, value) => { provider = value; return { dispose() {} }; } },
    lm: {
      selectChatModels: async () => { modelCalls++; throw new Error('OFF must not access models'); },
      registerMcpServerDefinitionProvider: () => ({ dispose() {} })
    }
  };
  const originalLoad = Module._load;
  const previousFetch = globalThis.fetch;
  const entry = require.resolve('../extension.cjs');
  try {
    Module._load = function (name, ...args) {
      if (name === 'vscode') return mock;
      if (name === './runtime.cjs') return { runtimeOptions: () => ({ url: 'http://127.0.0.1:37765' }), ensureRuntime: async () => {} };
      return originalLoad.call(this, name, ...args);
    };
    delete require.cache[entry];
    require(entry).activate({ extensionUri: {}, subscriptions: [] });
    Module._load = originalLoad;
    provider.view = { webview: { postMessage: async message => replies.push(message) } };
    globalThis.fetch = async url => {
      requests.push(new URL(url).pathname);
      return Response.json({ id: 1, title: '記憶', narrative: 'DBを保持する。' });
    };
    await provider.receive({ type: 'summarize', requestId: 1, id: 1 });
    assert.deepEqual(requests, ['/api/observation/1']);
    assert.equal(modelCalls, 0);
    assert.match(replies.at(-1).data.model, /no AI credits used/);
    await provider.receive({ type: 'setCopilot', requestId: 2, enabled: true });
    assert.equal(enabled, true);
    assert.equal(modelCalls, 0);
    assert.equal(requests.length, 1);
  } finally {
    provider?.dispose();
    globalThis.fetch = previousFetch;
    Module._load = originalLoad;
    delete require.cache[entry];
  }
});