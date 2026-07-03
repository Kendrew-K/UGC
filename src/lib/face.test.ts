import { describe, it, expect } from 'vitest';
import { resolveFace, generateAvatarOptions } from './face';

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

describe('generateAvatarOptions', () => {
  it('generates and downloads `count` distinct avatar options', async () => {
    let generateCalls = 0;
    const generate = async (_prompt: string) => {
      generateCalls += 1;
      return `http://img/${generateCalls}`;
    };
    const downloaded: Array<[string, string]> = [];
    const download = async (url: string, dest: string) => {
      downloaded.push([url, dest]);
      return dest;
    };
    const paths = await generateAvatarOptions('a friendly woman', 3, 'media/avatar-options', { generate, download });
    expect(generateCalls).toBe(3);
    expect(paths).toEqual([
      'media/avatar-options/option-0.jpg',
      'media/avatar-options/option-1.jpg',
      'media/avatar-options/option-2.jpg',
    ]);
    expect(downloaded).toHaveLength(3);
  });
});
