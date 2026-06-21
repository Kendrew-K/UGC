import { describe, it, expect } from 'vitest';
import { buildSteps } from './pipeline';

describe('buildSteps', () => {
  it('wires findCandidates -> prepareSource -> swap -> process', async () => {
    const steps = buildSteps({
      keywords: ['makeup'],
      faceImagePath: 'media/face.jpg',
      jobId: 1,
      deps: {
        find: async () => [
          { url: 'u', views: 9_000_000, downloadUrl: 'http://v/clip.mp4', hasVoice: false, platform: 'tiktok' },
        ],
        download: async (_u: string, dest: string) => dest,
        swap: async () => 'http://v/swapped.mp4',
        process: async (_i: string, o: string) => o,
        uploadForUrl: async (p: string) => `http://local/${p}`,
      },
    });
    const candidates = await steps.findCandidates();
    expect(candidates).toHaveLength(1);
    const sourcePath = await steps.prepareSource(candidates[0]);
    expect(sourcePath).toContain('media/jobs/1/source');
    const swapped = await steps.swap(sourcePath);
    expect(swapped).toContain('media/jobs/1/swapped');
    const final = await steps.process(swapped);
    expect(final).toContain('media/jobs/1/final');
  });

  it('returns an empty list when no viral candidates found', async () => {
    const steps = buildSteps({
      keywords: ['x'], faceImagePath: 'f.jpg', jobId: 2,
      deps: { find: async () => [], download: async (_u, d) => d, swap: async () => 's', process: async (_i, o) => o, uploadForUrl: async (p) => p },
    });
    await expect(steps.findCandidates()).resolves.toEqual([]);
  });
});
