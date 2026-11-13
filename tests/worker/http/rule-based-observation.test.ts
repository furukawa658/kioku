import { describe, it, expect } from 'bun:test';
import { buildRuleBasedObservation } from '../../../src/services/worker/http/rule-based-observation.js';

describe('buildRuleBasedObservation', () => {
  it('Editをファイル名と行数差で要約する', () => {
    const o = buildRuleBasedObservation('Edit', { file_path: '/a/b/index.ts', old_string: 'x\ny', new_string: 'z' }, 'ok');
    expect(o?.title).toBe('Edited index.ts');
    expect(o?.subtitle).toBe('-2 +1 lines');
    expect(o?.files_modified).toEqual(['/a/b/index.ts']);
  });

  it('Writeは行数を数える', () => {
    expect(buildRuleBasedObservation('Write', { file_path: 'a.md', content: '1\n2\n3' }, 'ok')?.subtitle).toBe('3 lines');
  });

  it('対象外ツールと失敗応答はnull', () => {
    expect(buildRuleBasedObservation('Bash', { command: 'ls' }, 'ok')).toBeNull();
    expect(buildRuleBasedObservation('Edit', { file_path: 'a.ts' }, { is_error: true })).toBeNull();
  });
});
