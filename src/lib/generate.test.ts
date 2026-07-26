import { describe, it, expect } from 'vitest';
import { generateVideoFromImage, generatePhotoFromImage } from './generate';
import type { runKieTask } from './kie';

describe('generateVideoFromImage', () => {
  it('submits the dressed avatar + prompt to the KIE i2v model and returns the video URL', async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const url = await generateVideoFromImage(
      { imageUrl: 'https://cdn/dressed.jpg', prompt: 'walks toward camera', durationS: 10 },
      { run: async (model, input) => { calls.push({ model, input }); return 'https://cdn/generated.mp4'; } }
    );
    expect(url).toBe('https://cdn/generated.mp4');
    expect(calls[0].model).toBeTruthy();
    expect(calls[0].input.image_urls).toEqual(['https://cdn/dressed.jpg']);
    expect(calls[0].input.prompt).toBe('walks toward camera');
    expect(calls[0].input.duration).toBe('10');
    expect(calls[0].input.sound).toBe(false);
  });

  it('defaults to a 10s generation and maps short requests to the "5" enum', async () => {
    const durations: unknown[] = [];
    const deps = { run: async (_m: string, input: Record<string, unknown>) => { durations.push(input.duration); return 'x'; } };
    await generateVideoFromImage({ imageUrl: 'u', prompt: 'p' }, deps);
    await generateVideoFromImage({ imageUrl: 'u', prompt: 'p', durationS: 5 }, deps);
    expect(durations).toEqual(['10', '5']);
  });

  it('honors the KIE_I2V_MODEL env override', async () => {
    process.env.KIE_I2V_MODEL = 'test/override-model';
    try {
      const calls: string[] = [];
      await generateVideoFromImage(
        { imageUrl: 'u', prompt: 'p' },
        { run: async (model) => { calls.push(model); return 'x'; } }
      );
      expect(calls[0]).toBe('test/override-model');
    } finally {
      delete process.env.KIE_I2V_MODEL;
    }
  });
});

describe('generatePhotoFromImage', () => {
  it('generatePhotoFromImage calls nano-banana edit with the avatar image and prompt', async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const run = (async (model, input) => { calls.push({ model, input }); return 'http://out/photo.jpg'; }) as typeof runKieTask;
    const url = await generatePhotoFromImage({ imageUrl: 'http://a/avatar.jpg', prompt: 'a woman in a studio', aspectRatio: '3:4' }, { run });
    expect(url).toBe('http://out/photo.jpg');
    expect(calls[0].model).toContain('nano-banana');
    expect(calls[0].input.image_urls).toEqual(['http://a/avatar.jpg']);
    expect(calls[0].input.prompt).toBe('a woman in a studio');
    expect(calls[0].input.aspect_ratio).toBe('3:4');
  });
});
