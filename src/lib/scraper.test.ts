import { describe, it, expect } from 'vitest';
import { filterViral, findViralVideos, type Candidate } from './scraper';

const c = (views: number, hasVoice: boolean): Candidate => ({
  url: 'u', views, downloadUrl: 'd', hasVoice, platform: 'tiktok',
});

describe('filterViral', () => {
  it('drops sub-1M and voiced clips, sorts by views desc', () => {
    const out = filterViral([c(2_000_000, false), c(500_000, false), c(3_000_000, true), c(5_000_000, false)]);
    expect(out.map((x) => x.views)).toEqual([5_000_000, 2_000_000]);
  });
});

describe('findViralVideos', () => {
  it('passes keywords to the runner and filters results', async () => {
    const run = async () => [c(9_000_000, false), c(10, false)];
    const out = await findViralVideos(['makeup'], { run });
    expect(out).toHaveLength(1);
    expect(out[0].views).toBe(9_000_000);
  });
});
