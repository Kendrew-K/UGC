import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { rankCandidates } from './evaluator';
import type { Candidate } from './scraper';
import type { Classification } from './classifier';

/** Fake Anthropic client that returns the given raw response text verbatim. */
function fakeClient(text: string) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } } as unknown as Anthropic;
}

function product(type: string, industry: string, gender: string): Classification {
  return { type, industry, gender: gender as Classification['gender'], contentStyle: 'solo-outfit', keywords: [type], searchQueries: [type] };
}

describe('rankCandidates single industry-match rubric', () => {
  it('keeps a mirror/second-person clip (no longer swap-gated)', async () => {
    const candidates = [
      { url: 'a', views: 2_000_000, coverUrl: 'http://c/a.jpg', downloadUrl: 'da' },
    ] as Candidate[];
    const client = fakeClient('[{"index":0,"score":8,"reason":"makeup, mirror ok"}]');
    const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
    expect(out).toHaveLength(1);
    expect(out[0].relevanceScore).toBe(8);
  });

  it('does not filter by clip length', async () => {
    const candidates = [
      { url: 'a', views: 2_000_000, durationS: 45, downloadUrl: 'da' },
    ] as Candidate[];
    const client = fakeClient('[{"index":0,"score":7,"reason":"long but fine"}]');
    const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
    expect(out).toHaveLength(1); // 45s clip survives — no MAX_CLIP_SECONDS cut
  });

  it('drops candidates below MIN_SCORE (3)', async () => {
    const candidates = [
      { url: 'a', views: 2_000_000, downloadUrl: 'da' },
      { url: 'b', views: 2_000_000, downloadUrl: 'db' },
    ] as Candidate[];
    const client = fakeClient('[{"index":0,"score":2,"reason":"collage"},{"index":1,"score":3,"reason":"ok"}]');
    const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
    expect(out.map((c) => c.url)).toEqual(['b']);
  });
});
