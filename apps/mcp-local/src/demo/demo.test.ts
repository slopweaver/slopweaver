import { describe, expect, it, vi } from 'vitest';
import { runDemo } from './index.ts';
import { DEMO_SNAPSHOT } from './synthetic-persona.ts';

describe('runDemo', () => {
  it('writes the synthetic snapshot to stdout and returns 0', async () => {
    const stdout = { write: vi.fn() };
    const code = await runDemo({ stdout });
    expect(code).toBe(0);
    expect(stdout.write).toHaveBeenCalledOnce();
    expect(stdout.write.mock.calls[0]?.[0]).toBe(DEMO_SNAPSHOT);
  });
});

describe('DEMO_SNAPSHOT', () => {
  it('does not contain personal identifiers', () => {
    // The synthetic persona is generic. Any real name / employer / channel
    // would be a leak — fail the build if one ever sneaks in.
    expect(DEMO_SNAPSHOT).not.toMatch(/Lachie|Everlab|@everlab/i);
  });

  it('ends with the canonical session-start closer', () => {
    expect(DEMO_SNAPSHOT).toContain('What are we working on this session?');
  });

  it('mentions the BYOK try-it-yourself path', () => {
    expect(DEMO_SNAPSHOT).toContain('claude mcp add slopweaver');
  });
});
