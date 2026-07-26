import { describe, it, expect } from 'vitest';
import { dressAvatar } from './tryon';

describe('dressAvatar', () => {
  it('passes both image urls and a prompt to the runner, returning its url', async () => {
    let seen: { avatarUrl: string; productUrl: string } | null = null;
    let seenPrompt = '';
    const run = async (input: { avatarUrl: string; productUrl: string }, prompt: string) => {
      seen = input;
      seenPrompt = prompt;
      return 'http://edited/avatar.jpg';
    };
    const out = await dressAvatar({ avatarUrl: 'http://a.jpg', productUrl: 'http://p.jpg' }, { run });
    expect(out).toBe('http://edited/avatar.jpg');
    expect(seen).toEqual({ avatarUrl: 'http://a.jpg', productUrl: 'http://p.jpg' });
    expect(seenPrompt).toMatch(/dress/i);
  });

  it('propagates runner failures', async () => {
    const run = async (): Promise<string> => { throw new Error('try-on edit failed: 422'); };
    await expect(dressAvatar({ avatarUrl: 'a', productUrl: 'p' }, { run })).rejects.toThrow(/422/);
  });
});
