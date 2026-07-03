import { describe, it, expect } from 'vitest';
import { filterViral, findViralVideos, resolveVideoUrl, type Candidate } from './scraper';

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
  it('passes searchQueries to the runner and filters results', async () => {
    const run = async () => [c(9_000_000, false), c(10, false)];
    const out = await findViralVideos(['men fit check jacket'], { run });
    expect(out).toHaveLength(1);
    expect(out[0].views).toBe(9_000_000);
  });

  it('throws when the sidecar process fails', async () => {
    const run = async (): Promise<Candidate[]> => { throw new Error('sidecar exited 1: blocked'); };
    await expect(findViralVideos(['q'], { run })).rejects.toThrow(/blocked/);
  });
});

describe('resolveVideoUrl', () => {
  it('returns whatever local path the sidecar resolver reports', async () => {
    const resolve = async (_url: string) => 'media/tmp/abc123.mp4';
    const out = await resolveVideoUrl('https://www.tiktok.com/@x/video/1', { resolve });
    expect(out).toBe('media/tmp/abc123.mp4');
  });

  it('throws when the sidecar resolver fails', async () => {
    const resolve = async (): Promise<string> => { throw new Error('resolve failed: 404'); };
    await expect(
      resolveVideoUrl('https://www.tiktok.com/@x/video/1', { resolve })
    ).rejects.toThrow(/404/);
  });
});
