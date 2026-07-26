/**
 * Live integration smoke test — gated behind RUN_LIVE_TESTS=1.
 *
 * Run manually (requires real API credentials):
 *   RUN_LIVE_TESTS=1 npx vitest run src/lib/integration.live.test.ts
 *
 * This file is intentionally excluded from CI. `npm test` without
 * RUN_LIVE_TESTS=1 will skip the entire describe block.
 */

import { describe, it, expect } from 'vitest';
import { classifyProduct } from './classifier';
import { findViralVideos } from './scraper';

// A small, publicly available product image (a simple PNG from Wikipedia).
const SAMPLE_IMAGE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

async function fetchToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// The live test suite — entirely skipped unless RUN_LIVE_TESTS=1.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.RUN_LIVE_TESTS)('Live integration smoke test', () => {
  it(
    'classifies a real product image via Claude vision',
    async () => {
      const base64 = await fetchToBase64(SAMPLE_IMAGE_URL);
      const result = await classifyProduct(base64);
      expect(typeof result.type).toBe('string');
      expect(result.type.length).toBeGreaterThan(0);
      expect(typeof result.industry).toBe('string');
      expect(Array.isArray(result.keywords)).toBe(true);
      expect(result.keywords.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'scrapes a real keyword and returns ≥1 viral candidate',
    async () => {
      const candidates = await findViralVideos(['skincare routine']);
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      const first = candidates[0];
      expect(typeof first.url).toBe('string');
      expect(first.views).toBeGreaterThanOrEqual(1_000_000);
      expect(first.hasVoice).toBe(false);
    },
    120_000,
  );
});
