import { describe, it, expect } from 'bun:test';
import { formatMcpPayload } from '../../src/servers/mcp-text-format.js';

describe('get_observations reports IDs it could not return', () => {
  it('lists requested IDs missing from the reply', () => {
    const text = formatMcpPayload('observations', [{ id: 1, title: 'kept', narrative: 'n' }], { requestedIds: [1, 99999, '#7'] }).content[0].text;
    expect(text).toContain('#1');
    expect(text).toContain('Not found: #99999, #7');
  });

  it('explains an entirely missing selection', () => {
    const text = formatMcpPayload('observations', [], { requestedIds: [42] }).content[0].text;
    expect(text).toContain('No selected observations found.');
    expect(text).toContain('Not found: #42');
  });

  it('adds nothing when every ID came back', () => {
    const text = formatMcpPayload('observations', [{ id: 1, title: 'kept' }], { requestedIds: [1] }).content[0].text;
    expect(text).not.toContain('Not found');
  });
});
