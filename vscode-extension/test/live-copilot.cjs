const fs = require('node:fs');
const { summarizeWithCopilot } = require('../copilot.cjs');

exports.run = async function (vscode = require('vscode')) {
  if (process.env.KIOKU_ALLOW_LIVE_COPILOT !== 'synthetic-only') throw new Error('Live Copilot verification requires explicit synthetic-only authorization.');
  const output = process.env.KIOKU_LIVE_RESULT;
  if (!output) throw new Error('KIOKU_LIVE_RESULT is required.');
  const report = { status: 'starting', syntheticOnly: true, memoryDatabaseRead: false, sends: 0 };
  const write = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  const claim = fs.openSync(output, 'wx');
  fs.writeFileSync(claim, JSON.stringify(report, null, 2));
  fs.closeSync(claim);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    await vscode.extensions.getExtension('GitHub.copilot-chat')?.activate();
    await vscode.extensions.getExtension('GitHub.copilot')?.activate();
    let models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
      report.status = 'waiting-for-models';
      write();
      models = await new Promise(resolve => {
        let finished = false;
        let deadline;
        const complete = found => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          listener.dispose();
          resolve(found);
        };
        const check = () => vscode.lm.selectChatModels({ vendor: 'copilot' }).then(found => {
          if (found.length) complete(found);
        }).catch(() => complete([]));
        const listener = vscode.lm.onDidChangeChatModels(check);
        deadline = setTimeout(() => complete([]), 45000);
        void check();
      });
    }
    report.availableCopilotModels = models.length;
    report.availableModels = (await vscode.lm.selectChatModels()).length;
    if (!models.length) throw new Error('No Copilot models are available in this VS Code profile.');
    const selected = models.find(model => model.family === 'gpt-4.1') ?? models[0];
    report.model = selected.id;
    report.status = 'requesting';
    write();
    const api = {
      ...vscode,
      window: {
        ...vscode.window,
        showWarningMessage: async () => 'Send and summarize',
        showQuickPick: async items => items.find(item => item.model.id === selected.id)
      },
      lm: {
        selectChatModels: async () => [{
          id: selected.id, name: selected.name, maxInputTokens: selected.maxInputTokens,
          countTokens: (...args) => selected.countTokens(...args),
          sendRequest: (...args) => {
            report.sends++;
            write();
            return selected.sendRequest(...args);
          }
        }]
      }
    };
    const result = await summarizeWithCopilot(api, {
      isEnabled: () => true,
      id: 1,
      signal: controller.signal,
      loadObservation: async () => ({
        title: 'kioku接続テスト（合成データ）',
        narrative: 'これは合成データによる接続テストです。実際の記憶DBは読みません。要約の結果が表示できることを確認します。',
        facts: ['機密情報は含まない', '送信はこのテストの1回だけ']
      })
    });
    if (report.sends !== 1 || !result.text.trim()) throw new Error('Expected exactly one successful Copilot response.');
    report.status = 'passed';
    report.responseCharacters = result.text.length;
    write();
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    write();
    throw error;
  } finally {
    clearTimeout(timer);
  }
};