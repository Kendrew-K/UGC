import { describe, it, expect } from 'vitest';
import { filterViral, findViralVideos, findViralPhotos, resolveVideoUrl, type Candidate } from './scraper';

let nextId = 0;
const c = (views: number, hasVoice: boolean, url?: string): Candidate => ({
  url: url ?? `u${nextId++}`, views, downloadUrl: 'd', hasVoice, platform: 'tiktok',
});

describe('filterViral', () => {
  it('drops sub-1M and voiced clips, sorts by views desc', () => {
    const out = filterViral([c(2_000_000, false), c(500_000, false), c(3_000_000, true), c(5_000_000, false)]);
    expect(out.map((x) => x.views)).toEqual([5_000_000, 2_000_000]);
  });

  it('dedupes repeated URLs, keeping the first occurrence', () => {
    const out = filterViral([c(2_000_000, false, 'dup'), c(5_000_000, false, 'dup')]);
    expect(out.map((x) => x.views)).toEqual([2_000_000]);
  });
});

describe('findViralVideos', () => {
  it('relaxes the view floor when few clips clear 1M, keeping views sorted desc', async () => {
    // Only one 1M+ clip -> the adaptive floor steps down rather than
    // presenting the client a single take-it-or-leave-it choice.
    const run = async () => [c(9_000_000, false), c(10, false)];
    const out = await findViralVideos(['men fit check jacket'], { run });
    expect(out).toHaveLength(2);
    expect(out[0].views).toBe(9_000_000);
  });

  it('keeps the 1M floor when enough clips clear it', async () => {
    const viral = [1, 2, 3, 4, 5].map((m) => c(m * 1_000_000, false));
    const run = async () => [...viral, c(10, false)];
    const out = await findViralVideos(['q'], { run });
    expect(out).toHaveLength(5);
    expect(out.every((x) => x.views >= 1_000_000)).toBe(true);
  });

  it('throws when the sidecar process fails', async () => {
    const run = async (): Promise<Candidate[]> => { throw new Error('sidecar exited 1: blocked'); };
    await expect(findViralVideos(['q'], { run })).rejects.toThrow(/blocked/);
  });
});

describe('findViralPhotos', () => {
  const photo = (views: number, url?: string): Candidate => ({
    url: url ?? `p${nextId++}`, views, downloadUrl: 'https://cdn/img.jpg',
    imageUrls: ['https://cdn/img.jpg'], hasVoice: false, platform: 'tiktok',
  });

  it('applies the adaptive view floor and sorts by views desc', async () => {
    const run = async () => [photo(9_000_000), photo(10)];
    const out = await findViralPhotos(['leather jacket outfit photo'], { run });
    expect(out).toHaveLength(2);
    expect(out[0].views).toBe(9_000_000);
  });

  it('never filters photos out for missing duration', async () => {
    // Photos have no durationS at all; the video minimum-length rule must not apply.
    const viral = [1, 2, 3, 4, 5].map((m) => photo(m * 1_000_000));
    const out = await findViralPhotos(['q'], { run: async () => viral });
    expect(out).toHaveLength(5);
  });

  it('dedupes repeated post URLs', async () => {
    const out = await findViralPhotos(['q'], { run: async () => [photo(2_000_000, 'dup'), photo(3_000_000, 'dup')] });
    expect(out).toHaveLength(1);
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
