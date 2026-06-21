import { describe, it, expect } from 'vitest';
import { buildSteps } from './pipeline';
import type { Candidate } from './scraper';
import type { Classification } from './classifier';

const mockProduct: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'> = {
  type: 'makeup', industry: 'beauty', gender: 'female', contentStyle: 'beauty-routine',
};

const clip: Candidate = { url: 'u', views: 9_000_000, downloadUrl: 'http://v/clip.mp4', hasVoice: false, platform: 'tiktok' };

describe('buildSteps', () => {
  it('wires findCandidates -> prepareSource -> swap -> process', async () => {
    const steps = buildSteps({
      searchQueries: ['women makeup tutorial'],
      faceImagePath: 'media/face.jpg',
      jobId: 1,
      product: mockProduct,
      deps: {
        find: async () => [clip],
        rank: async (_p, candidates) => candidates.map((c) => ({ ...c, relevanceScore: 9, reason: 'great match' })),
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

  it('throws when all candidates are filtered out by the ranker', async () => {
    const steps = buildSteps({
      searchQueries: ['x'], faceImagePath: 'f.jpg', jobId: 2, product: mockProduct,
      deps: {
        find: async () => [clip],
        rank: async () => [],
        download: async (_u, d) => d,
        swap: async () => 's',
        process: async (_i, o) => o,
        uploadForUrl: async (p) => p,
      },
    });
    await expect(steps.findCandidates()).rejects.toThrow('No relevant candidates');
  });
});
