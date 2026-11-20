const path = require('node:path');

const START = '<!-- kioku-memory-instructions:start -->';
const END = '<!-- kioku-memory-instructions:end -->';
const BLOCK = `${START}
## Long-term memory (kioku)

- Before non-trivial debugging, migration, or build work, call kioku \`search\` with \`concepts="lesson"\` for relevant past lessons.
- After hard work succeeds or fails, call kioku \`save_memory\` with \`outcome\`, a verified \`cause\`, and a reusable \`lesson\`. Use \`supersedes\` for an intentional replacement; otherwise let the duplicate guard protect existing memories.
- Save reusable user corrections and standing instructions as lessons under the \`user-memory\` project.
- Never store credentials, personal data, or confidential material.
${END}`;

function upsertInstructions(current) {
  const text = typeof current === 'string' ? current : '';
  const start = text.indexOf(START);
  const end = text.indexOf(END, start + START.length);
  if (start >= 0 && end >= 0) {
    const after = end + END.length;
    return `${text.slice(0, start)}${BLOCK}${text.slice(after)}`;
  }
  const prefix = text.trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}${BLOCK}\n`;
}

function globalInstructionsPath(home, platform = process.platform, env = process.env) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Code', 'User', 'prompts', 'instructions.md');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User', 'prompts', 'instructions.md');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Code', 'User', 'prompts', 'instructions.md');
}

function mcpConfig(options) {
  return JSON.stringify({
    mcpServers: {
      kioku: {
        type: 'stdio',
        command: options.command,
        args: [options.mcp],
        env: options.overrides
      }
    }
  }, null, 2);
}

module.exports = { BLOCK, END, START, globalInstructionsPath, mcpConfig, upsertInstructions };
