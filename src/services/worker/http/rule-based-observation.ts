// LLMを使わず、ファイル編集系ツールの観察をルールで生成する。
import { basename } from 'path';

export interface RuleBasedObservation {
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  files_modified: string[];
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function countLines(text: unknown): number {
  return typeof text === 'string' && text.length > 0 ? text.split('\n').length : 0;
}

/** 対象外のツール、または失敗した操作はnullを返し、従来のLLM経路に任せる。 */
export function buildRuleBasedObservation(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): RuleBasedObservation | null {
  if (!EDIT_TOOLS.has(toolName) || !toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  const filePath = String(input.file_path ?? input.notebook_path ?? '');
  if (!filePath) return null;

  const responseText = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? '');
  if (/"?(error|is_error)"?\s*[:=]\s*(true|"[^"]+")/i.test(responseText)) return null;

  const name = basename(filePath);
  let verb: string;
  let detail: string;
  if (toolName === 'Write') {
    verb = 'Wrote';
    detail = `${countLines(input.content)} lines`;
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits.length : 0;
    verb = 'Edited';
    detail = `${edits} edits`;
  } else if (toolName === 'NotebookEdit') {
    verb = 'Edited notebook';
    detail = String(input.edit_mode ?? 'replace');
  } else {
    verb = 'Edited';
    detail = `-${countLines(input.old_string)} +${countLines(input.new_string)} lines`;
  }

  return {
    type: 'change',
    title: `${verb} ${name}`,
    subtitle: detail,
    narrative: `${verb} ${filePath} (${detail}).`,
    files_modified: [filePath],
  };
}
