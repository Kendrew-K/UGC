import { describe, it, expect } from 'vitest';
import { buildRemakeSteps, buildPictureRemakeSteps, nearestAspectRatio } from './pipeline';
import type { Candidate } from './scraper';
import type { Classification } from './classifier';

const mockProduct: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'> = {
  type: 'makeup', industry: 'beauty', gender: 'female', contentStyle: 'beauty-routine',
};

const clip: Candidate = { url: 'u', views: 9_000_000, downloadUrl: 'http://v/clip.mp4', hasVoice: false, platform: 'tiktok' };

describe('nearestAspectRatio', () => {
  it('maps image dimensions to the nearest supported aspect ratio', async () => {
    expect(await nearestAspectRatio('x.jpg', { probe: async () => ({ width: 1080, height: 1920 }) })).toBe('9:16');
    expect(await nearestAspectRatio('x.jpg', { probe: async () => ({ width: 1080, height: 1440 }) })).toBe('3:4');
    expect(await nearestAspectRatio('x.jpg', { probe: async () => ({ width: 1000, height: 1000 }) })).toBe('1:1');
    // Probe failure must not fail the swap — the model default takes over.
    expect(await nearestAspectRatio('x.jpg', { probe: async () => { throw new Error('no ffprobe'); } })).toBeUndefined();
  });
});

describe('buildRemakeSteps', () => {
  const brief = {
    summary: 's',
    subject: { description: 'someone', outfitStyle: 'jacket' },
    beats: [{ t: '0s', action: 'walks toward camera' }],
    scene: { setting: 'street', timeOfDay: 'day', overlays: 'N/A', dynamics: 'N/A' },
    spatialFraming: { shotSize: 'full body', subjectPosition: 'center', depth: 'shallow' },
    camera: { movement: 'static', angle: 'eye level', steadiness: 'steady', speed: 'real-time' },
    lighting: { direction: 'soft front light', quality: 'diffused daylight' },
    colorGrade: 'neutral warm',
    skinTexture: 'natural with visible pores',
    pacing: 'steady',
    whatMakesItWork: ['x'],
    differentiationSeeds: ['plain studio backdrop'],
  };

  function makeSteps(overrides: Record<string, unknown> = {}) {
    const calls = { generate: [] as Array<{ imageUrl: string; prompt: string }>, qc: 0 };
    const steps = buildRemakeSteps({
      searchQueries: ['q'], faceImagePath: 'media/face.jpg', productPhotoPath: 'media/products/7.jpg',
      jobId: 30, product: mockProduct,
      deps: {
        find: async () => [clip],
        rank: async (_p, cs) => cs.map((c) => ({ ...c, relevanceScore: 9, reason: 'r' })),
        download: async (_u: string, dest: string) => dest,
        resolveVideo: async () => 'http://v/clip.mp4',
        describe: async () => brief,
        generate: async (input: { imageUrl: string; prompt: string }) => { calls.generate.push(input); return 'http://cdn/generated.mp4'; },
        process: async (_i: string, o: string) => o,
        uploadForUrl: async (p: string) => `http://local/${p}`,
        dress: async ({ avatarUrl }: { avatarUrl: string }) => `http://dressed/${avatarUrl}`,
        checkVideo: async () => { calls.qc++; return { pass: true, reason: 'clean' }; },
        ...overrides,
      },
    });
    return { steps, calls };
  }

  it('generates from the dressed avatar with the brief-derived prompt', async () => {
    const { steps, calls } = makeSteps();
    const swapped = await steps.generate('media/jobs/30/source.mp4');
    expect(swapped).toBe('media/jobs/30/swapped.mp4');
    expect(calls.generate[0].imageUrl).toBe('http://dressed/http://local/media/face.jpg');
    expect(calls.generate[0].prompt).toContain('walks toward camera');
    expect(calls.generate[0].prompt).toContain('plain studio backdrop');
  });

  it('regenerates once when QC rejects, and returns the clean retry', async () => {
    const verdicts = [{ pass: false, reason: 'melted' }, { pass: true, reason: 'clean' }];
    const { steps, calls } = makeSteps({ checkVideo: async () => verdicts.shift()! });
    await expect(steps.generate('media/jobs/30/source.mp4')).resolves.toBe('media/jobs/30/swapped.mp4');
    expect(calls.generate).toHaveLength(2);
  });

  it('throws when the retry also fails QC, using the revert-to-approval error convention', async () => {
    const { steps } = makeSteps({ checkVideo: async () => ({ pass: false, reason: 'melted' }) });
    await expect(steps.generate('media/jobs/30/source.mp4')).rejects.toThrow(/quality check failed.*melted/);
  });

  it('throws when the dressed avatar fails identity check, before spending on generation', async () => {
    const { steps } = makeSteps({
      dress: async () => 'http://dressed/x',
      checkIdentity: async () => ({ pass: false, reason: 'different person entirely' }),
      generate: async () => { throw new Error('generate must not be called'); },
    });
    await expect(steps.generate('media/jobs/30/source.mp4')).rejects.toThrow(/avatar identity check failed.*different person/);
  });

  it('prepareSource downloads without the source-suitability gate', async () => {
    const { steps } = makeSteps(); // no checkSource dep exists on remake deps at all
    await expect(steps.prepareSource(clip)).resolves.toBe('media/jobs/30/source.mp4');
  });

  it('ranks candidates with the two-arg rank call (no mode)', async () => {
    let seenArgCount = -1;
    const { steps } = makeSteps({
      rank: async (...args: unknown[]) => {
        seenArgCount = args.length;
        const cs = args[1] as Candidate[];
        return cs.map((c) => ({ ...c, relevanceScore: 9, reason: 'r' }));
      },
    });
    await steps.findCandidates();
    expect(seenArgCount).toBe(2);
  });

  it('throws when all candidates are filtered out by the ranker', async () => {
    const { steps } = makeSteps({ rank: async () => [] });
    await expect(steps.findCandidates()).rejects.toThrow('No relevant candidates');
  });
});

describe('buildPictureRemakeSteps', () => {
  const baseDeps = {
    find: async () => [{ url: 'u', views: 2e6, downloadUrl: 'http://c/p.jpg' }] as Candidate[],
    rank: async (_p: unknown, c: Candidate[]) => c.map((x) => ({ ...x, relevanceScore: 8, reason: 'ok' })),
    download: async (_url: string, dest: string) => dest,
    describePhoto: async () => ({
      summary: 's', subject: { description: 'w', outfitStyle: 'c' },
      scene: { setting: 'room', timeOfDay: 'day', overlays: 'N/A' },
      spatialFraming: { shotSize: 'mcu', subjectPosition: 'center', depth: 'shallow' },
      lighting: { direction: 'left', quality: 'soft' }, colorGrade: 'warm', skinTexture: 'natural',
      whatMakesItWork: ['a', 'b', 'c'], differentiationSeeds: ['studio', 'x', 'y'],
    }),
    generatePhoto: async () => 'http://out/gen.jpg',
    processImage: async (_i: string, o: string) => o,
    uploadForUrl: async () => 'http://up/img',
    checkImage: async () => ({ pass: true, reason: '' }),
    checkIdentity: async () => ({ pass: true, reason: '' }),
    dress: async () => 'http://up/dressed',
  };

  it('generates, QC-passes and processes a picture without any swap', async () => {
    const steps = buildPictureRemakeSteps({ searchQueries: ['makeup'], faceImagePath: 'media/jobs/1/face.jpg', jobId: 1, deps: baseDeps as never });
    const src = await steps.prepareSource({ url: 'u', views: 2e6, downloadUrl: 'http://c/p.jpg' } as Candidate);
    expect(src).toContain('source.jpg');
    const out = await steps.generate(src);
    expect(out).toContain('gen.jpg');
    const fin = await steps.process(out as string);
    expect(fin).toContain('final.jpg');
  });

  it('rerolls once on QC failure then fails to approval', async () => {
    let n = 0;
    const steps = buildPictureRemakeSteps({
      searchQueries: ['makeup'], faceImagePath: 'media/jobs/1/face.jpg', jobId: 1,
      deps: { ...baseDeps, checkImage: async () => { n++; return { pass: false, reason: 'extra hand' }; } } as never,
    });
    await expect(steps.generate('media/jobs/1/source.jpg')).rejects.toThrow(/quality check failed/);
    expect(n).toBe(2); // one initial + one reroll
  });
});
