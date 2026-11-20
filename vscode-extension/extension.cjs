const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { summarizeWithCopilot } = require('./copilot.cjs');
const { summarizeLocally } = require('./local-summary.cjs');
const { runtimeOptions, ensureRuntime } = require('./runtime.cjs');
const { createMcpProvider } = require('./mcp-provider.cjs');
const { LANGUAGES, normalizeLanguage } = require('./language.cjs');
const { globalInstructionsPath, mcpConfig, upsertInstructions } = require('./onboarding.cjs');

function activate(context) {
  const provider = new SearchView(context.extensionUri);
  context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider('kioku.search', provider));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('kioku.local', createMcpProvider(vscode, context.extensionUri.fsPath)));
  if (vscode.commands?.registerCommand) {
    context.subscriptions.push(vscode.commands.registerCommand('kioku.injectInstructions', () => provider.injectInstructions()));
    context.subscriptions.push(vscode.commands.registerCommand('kioku.copyMcpConfig', () => provider.copyMcpConfig()));
    context.subscriptions.push(vscode.commands.registerCommand('kioku.exportLessons', () => provider.exportLessons()));
    context.subscriptions.push(vscode.commands.registerCommand('kioku.importLessons', () => provider.importLessons()));
  }
}

class SearchView {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.controllers = new Map();
    this.disposables = [];
    this.generation = 0;
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('kioku.copilotEnabled')) {
        this.controllers.get('summarize')?.abort();
        void this.view?.webview.postMessage({ type: 'copilotChanged', data: { enabled: this.copilotEnabled() } });
      }
      if (event.affectsConfiguration('kioku.language')) {
        void this.view?.webview.postMessage({ type: 'languageChanged', data: { language: this.language() } });
      }
    }));
  }

  copilotEnabled() {
    return vscode.workspace.getConfiguration('kioku').get('copilotEnabled', false) === true;
  }

  language() {
    return normalizeLanguage(vscode.workspace.getConfiguration('kioku').get('language', 'en'));
  }

  async injectInstructions() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const choices = [];
    if (workspaceRoot) choices.push({ label: 'Workspace instructions', target: path.join(workspaceRoot, '.github', 'copilot-instructions.md') });
    choices.push({ label: 'Global instructions', target: globalInstructionsPath(os.homedir()) });
    const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'Choose where to install the kioku memory instructions' });
    if (!selected) return;
    fs.mkdirSync(path.dirname(selected.target), { recursive: true });
    const current = fs.existsSync(selected.target) ? fs.readFileSync(selected.target, 'utf8') : '';
    fs.writeFileSync(selected.target, upsertInstructions(current), 'utf8');
    const document = await vscode.workspace.openTextDocument(selected.target);
    await vscode.window.showTextDocument(document);
    vscode.window.showInformationMessage('kioku memory instructions were added.');
  }

  async copyMcpConfig() {
    const configured = vscode.workspace.getConfiguration('kioku').get('workerUrl', '');
    const options = runtimeOptions(this.extensionUri.fsPath, configured);
    await vscode.env.clipboard.writeText(mcpConfig(options));
    vscode.window.showInformationMessage('kioku .mcp.json configuration copied to the clipboard.');
  }

  async lessonClient() {
    const { KiokuClient } = await import('./client.mjs');
    const configured = vscode.workspace.getConfiguration('kioku').get('workerUrl', '');
    const options = runtimeOptions(this.extensionUri.fsPath, configured);
    await ensureRuntime(options);
    const client = new KiokuClient(options.url, undefined, this.language());
    const overview = await client.overview();
    if (overview.projects.length === 0) throw new Error('No kioku projects are available.');
    const project = await vscode.window.showQuickPick(overview.projects, { placeHolder: 'Choose a kioku project' });
    return project ? { client, project } : null;
  }

  async exportLessons() {
    const selected = await this.lessonClient();
    if (!selected) return;
    const format = await vscode.window.showQuickPick(['jsonl', 'markdown'], { placeHolder: 'Choose an export format' });
    if (!format) return;
    const extension = format === 'markdown' ? 'md' : 'jsonl';
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${selected.project.replace(/[^a-zA-Z0-9._-]/g, '-')}.kioku.${extension}`)),
      filters: { 'kioku lessons': [extension] },
    });
    if (!target) return;
    const text = await selected.client.exportLessons(selected.project, format);
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    vscode.window.showInformationMessage(`Exported kioku lessons to ${path.basename(target.fsPath)}.`);
  }

  async importLessons() {
    const [target] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'kioku lessons': ['jsonl', 'md'] } }) ?? [];
    if (!target) return;
    const selected = await this.lessonClient();
    if (!selected) return;
    const format = target.path.toLowerCase().endsWith('.md') ? 'markdown' : 'jsonl';
    const data = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
    const result = await selected.client.importLessons(selected.project, format, data);
    vscode.window.showInformationMessage(`Imported ${result.imported} kioku lessons; skipped ${result.duplicates} duplicates.`);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = randomBytes(24).toString('hex');
    const resource = file => view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file)).toString();
    let html = fs.readFileSync(path.join(this.extensionUri.fsPath, 'media', 'sidebar.html'), 'utf8');
    for (const [key, value] of Object.entries({ nonce, csp: view.webview.cspSource, language: this.language(), css: resource('sidebar.css'), js: resource('sidebar.js'), brain: resource('brain.png'), refresh: resource('refresh-cw.svg'), settings: resource('settings.svg'), search: resource('search.svg'), close: resource('x.svg'), sparkles: resource('sparkles.svg') })) {
      html = html.replaceAll(`{{${key}}}`, value);
    }
    view.webview.html = html;
    this.disposables.push(view.webview.onDidReceiveMessage(message => this.receive(message)));
    this.disposables.push(view.onDidDispose(() => this.abortAll()));
  }

  abortAll() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.generation++;
  }

  async receive(message) {
    if (!message || !['overview', 'search', 'detail', 'settings', 'copilotState', 'setCopilot', 'summarize', 'cancelSummary', 'setLanguage', 'editMemory', 'invalidateMemory', 'injectInstructions', 'copyMcpConfig', 'workState', 'clearWorkState'].includes(message.type)) return;
    if (message.type === 'injectInstructions') { await this.injectInstructions(); return; }
    if (message.type === 'copyMcpConfig') { await this.copyMcpConfig(); return; }
    if (message.type === 'cancelSummary') {
      this.controllers.get('summarize')?.abort();
      return;
    }
    if (message.type === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'kioku.workerUrl');
      return;
    }
    if (message.type === 'setLanguage') {
      try {
        if (LANGUAGES.includes(message.language)) {
          await vscode.workspace.getConfiguration('kioku').update('language', message.language, vscode.ConfigurationTarget.Global);
        }
      } catch {
      } finally {
        await this.view?.webview.postMessage({ type: 'languageChanged', data: { language: this.language() } });
      }
      return;
    }
    const type = message.type;
    if (!Number.isSafeInteger(message.requestId)) return;
    const generation = this.generation;
    this.controllers.get(type)?.abort();
    const controller = new AbortController();
    this.controllers.set(type, controller);
    try {
      if (type === 'copilotState' || type === 'setCopilot') {
        if (type === 'setCopilot') {
          if (typeof message.enabled !== 'boolean') throw new Error(this.language() === 'ja' ? 'Copilot設定が正しくありません。' : 'The Copilot setting is invalid.');
          if (!message.enabled) this.controllers.get('summarize')?.abort();
          await vscode.workspace.getConfiguration('kioku').update('copilotEnabled', message.enabled, vscode.ConfigurationTarget.Global);
        }
        await this.view?.webview.postMessage({ type, requestId: message.requestId, data: { enabled: this.copilotEnabled() } });
        return;
      }
      const { KiokuClient } = await import('./client.mjs');
      const configured = vscode.workspace.getConfiguration('kioku').get('workerUrl', '');
      const options = runtimeOptions(this.extensionUri.fsPath, configured);
      await ensureRuntime(options);
      const client = new KiokuClient(options.url, undefined, this.language());
      let data;
      if (type === 'overview') {
        const overview = await client.overview(controller.signal);
        const version = JSON.parse(fs.readFileSync(path.join(this.extensionUri.fsPath, 'package.json'), 'utf8')).version;
        data = { ...overview, workerVersion: overview.version, version };
      }
      if (type === 'search') data = await client.search(message.input ?? {}, controller.signal);
      if (type === 'detail') data = await client.observation(message.id, controller.signal);
      if (type === 'workState') data = await client.workState(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, controller.signal);
      if (type === 'clearWorkState') data = await client.clearWorkState(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, controller.signal);
      if (type === 'editMemory') data = await client.editMemory(message.id, message.input ?? {}, controller.signal);
      if (type === 'invalidateMemory') data = await client.invalidateMemory(message.id, message.input ?? {}, controller.signal);
      if (type === 'summarize') {
        const lang = this.language();
        if (this.copilotEnabled()) {
          data = await summarizeWithCopilot(vscode, {
            isEnabled: () => this.copilotEnabled(),
            loadObservation: (id, signal) => client.observation(id, signal),
            id: message.id, signal: controller.signal,
            language: lang
          });
        } else {
          const row = await client.observation(message.id, controller.signal);
          if (!controller.signal.aborted) data = summarizeLocally(row, lang);
        }
      }
      if (!controller.signal.aborted && generation === this.generation) {
        await this.view?.webview.postMessage({ type, requestId: message.requestId, data });
      }
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.view?.webview.postMessage({ type, requestId: message.requestId, error: detail });
      }
    } finally {
      if (this.controllers.get(type) === controller) this.controllers.delete(type);
    }
  }

  dispose() {
    this.abortAll();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

module.exports = { activate };