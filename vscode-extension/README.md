# kioku

kioku ("memory" in Japanese) gives AI coding agents a long-term memory on your own PC. Its purpose is to make the AI behave more wisely over time: it keeps not only what was done, but why work succeeded or failed and the lesson to apply next time.

- **Learn from successes and failures.** When work succeeds or fails, the agent saves the outcome, the cause and the lesson. Lessons can be searched on their own, so the same mistake is not repeated and what worked is reused.
- **Share memory across chats and across time.** Memories are stored in one local database instead of inside a single conversation. A new chat can search what earlier chats decided and learned, so handoffs between sessions and the AI's judgments rest on recorded facts instead of guesses.

kioku is developed as a fork of [claude-mem](https://github.com/thedotmack/claude-mem). It keeps claude-mem's worker, database and MCP tools, and is distributed under the same Apache-2.0 license.

## What kioku adds to claude-mem

- **Lesson fields.** `save_memory` accepts `outcome`, `cause` and `lesson`, and `search` can select lessons with `concepts="lesson"`. The tool instructions ask the agent to record the cause and the lesson, not only progress or results.
- **A self-contained VS Code extension.** One VSIX bundles the MCP server, the worker and the Bun runtime, and registers the MCP server for Copilot Chat. Node.js, Bun and Claude Code do not need to be installed.
- **Offline meaning search.** A multilingual embedding model and ONNX Runtime are bundled. Vectors are stored in SQLite and combined with keyword search. No Chroma server, model download or external request is needed.
- **A search sidebar.** Search memories by keyword, project and date and read the full text, in English or Japanese.
- **Summaries without AI credits.** A local script makes an extractive summary. Summarizing with GitHub Copilot is an explicit opt-in.
- **Local-only defaults.** Automatic conversation capture, observation by an external AI, cloud sync, telemetry and automatic updates are turned off.

This extension is for Windows x64 and requires VS Code 1.102 or later. PostgreSQL is not required. Saving and searching work offline, and no model is downloaded at first use.

## Install

1. In the VS Code Extensions view, select "Install from VSIX..." and choose the distributed `kioku-search-0.3.0-win32-x64.vsix`. If an earlier version with the same extension ID exists, it will be updated in place.
2. Reload VS Code if prompted, and open a trusted workspace folder.
3. Open the kioku brain icon on the activity bar. If the worker is not running, the bundled version starts. On first launch, wait for database initialization. A memory count of 0 is normal for a new user.
4. In Copilot Chat's MCP list, start "kioku (local)" and allow access in the VS Code confirmation prompt.

If you already have a manually configured kioku MCP server, disable the manual configuration before using the bundled version. Do not register the same functionality twice. The extension never deletes or overwrites existing MCP configuration files.

## Language

The sidebar UI is English by default and can be switched to Japanese using the language selector in the sidebar header or the `kioku.language` configuration setting. VS Code dialogs (such as Copilot model selection and send confirmation) remain in English.

## Saving and searching

Prompt Copilot Chat explicitly: "Save this decision with kioku save_memory". Do not include confidential information or credentials in memories. The chat interaction itself that invokes the MCP tool is subject to your Copilot terms and plan.

When saving successful or failed work, specify the `save_memory` fields `outcome` (`success`, `failure`, or `mixed`), `cause` (reason for success or failure), and `lesson` (what to do or avoid next time, and under what conditions). Memories with a `lesson` can be filtered in `search` by setting `concepts` to `lesson`.

Use the kioku brain icon to search by keywords, project, start date, and end date. Up to 50 results are displayed; selecting a result shows the body and facts. The view also displays connection status and the total memory count. There is no delete action in the UI.

The bundled version uses explicit saving and SQLite search. It combines keyword search with semantic search using vectors stored in SQLite, computing similarity inside the worker. A multilingual embedding model (including Japanese support) runs locally on your PC without sending search queries or memories to external servers. An index is built from stored memories on the first search; thereafter, embeddings are recalculated only for memories whose content has changed. Initial search indexing time depends on the number of memories.

Automatic conversation harvesting, observation by external AI, Chroma, cloud synchronization, telemetry, and automatic updates are disabled at startup. This extension does not automatically record complete chat transcripts. Authentication and code analysis designed for shared servers are not used. The header displays the extension version; the internal worker version can be checked in the connection tooltip.

## Summaries

Copilot summaries are off by default. When off, clicking "Summarize with script" creates an extractive summary locally on your PC from the original text. It displays the title, subtitle, up to 6 facts, and the beginning of the body, indicating if content was omitted. This operation involves no external network transmission and consumes no AI credits.

When on, clicking "Summarize with Copilot" after selecting a memory proceeds to an explicit confirmation prompt and model selection. Only the title, subtitle, body, and facts of the selected memory are sent. Switching the setting on sends nothing. The summary result is displayed temporarily and does not modify the original memory.

Copilot sign-in, available models, usage quotas, and organization policies follow your environment. If no model is available, an error is shown without falling back to another service. Switching Copilot off cancels an in-progress summary, but already transmitted data cannot be recalled. The statement that script summaries consume no credits applies strictly to local script summaries within this extension.

## Data and existing environment

The default storage directory is `%USERPROFILE%\.claude-mem`. Existing `CLAUDE_MEM_DATA_DIR` environment variables or paths defined in existing configuration files are respected. If an existing database is found, it is reused; if none exists, an empty database is created on first startup. The distribution package contains no user databases, memories, or credentials. Updating, reinstalling, or uninstalling the extension does not delete personal data. Memories are not automatically transferred to other PCs.

The worker only communicates over loopback addresses on the local machine. The port is determined from existing settings and worker port calculation logic. If necessary, specify a loopback HTTP URL in the VS Code setting `kioku.workerUrl`. Non-loopback URLs, credentials embedded in URLs, and redirects are rejected.

If a worker of the same version supporting local semantic search is already running, it is reused. Configuration files specific to that worker are not modified by this extension. A shared worker is not terminated when VS Code exits.

If a worker with a mismatched version or a different service responds, it is not stopped or replaced; instead, an error is reported. Stop the older worker after identifying its caller, then retry. Back up your existing database before opening it with a new version for the first time. The worker performs any necessary database migrations automatically. If startup fails, check the `logs` folder in the data directory.

## Build

On Windows x64, prepare the worker dependencies, extension devDependencies, and Google Chrome. Building requires Node.js 24 or later, Bun, and PowerShell 7. These are not needed after distributing the package to users. Network access is used only during the build to fetch pinned model files and licenses. Model and tokenizer files are verified by size and SHA-256 hash. Runtime model loading is restricted strictly to local files.

```powershell
npm run typecheck:root
npm run build
npm --prefix vscode-extension ci --ignore-scripts
npm --prefix vscode-extension run build
npm --prefix vscode-extension run check
npm --prefix vscode-extension test
node vscode-extension/test/integrated-smoke.mjs
```

Run `vsce package --target win32-x64 --no-dependencies --allow-missing-repository` in the extension folder. SHA-256 hashes of bundled runtime files are listed in `runtime/integrity.json`; licenses and notices are included in `runtime/licenses` and `runtime/THIRD-PARTY-NOTICES.txt`. The license for the Lucide toolbar icons is in `media/lucide-license.txt`.