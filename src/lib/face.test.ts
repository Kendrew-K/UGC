import { describe, it, expect } from 'vitest';
import { resolveFace } from './face';

describe('resolveFace', () => {
  it('returns the uploaded path unchanged', async () => {
    const out = await resolveFace({ kind: 'upload', path: 'media/face.jpg' }, 'media/dest.jpg');
    expect(out).toBe('media/face.jpg');
  });

  it('generates via avatar API then downloads to dest', async () => {
    const generate = async (p: string) => `http://img/${encodeURIComponent(p)}`;
    const download = async (_url: string, dest: string) => dest;
    const out = await resolveFace(
      { kind: 'generate', prompt: 'a friendly woman, studio light' },
      'media/dest.jpg',
      { generate, download }
    );
    expect(out).toBe('media/dest.jpg');
  });
});
