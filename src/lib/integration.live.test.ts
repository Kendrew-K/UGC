/**
 * Live integration smoke test — gated behind RUN_LIVE_TESTS=1.
 *
 * Run manually (requires real API credentials):
 *   RUN_LIVE_TESTS=1 npx vitest run src/lib/integration.live.test.ts
 *
 * This file is intentionally excluded from CI. `npm test` without
 * RUN_LIVE_TESTS=1 will skip the entire describe block.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect } from 'vitest';
import { classifyProduct } from './classifier';
import { findViralVideos } from './scraper';
import { getSwapProvider } from './swap';

// ---------------------------------------------------------------------------
// Helper: upload a local file to fal.ai storage and return a public URL.
// ---------------------------------------------------------------------------
async function uploadForUrl(localPath: string): Promise<string> {
  const data = fs.readFileSync(localPath);
  const filename = path.basename(localPath);
  const res = await fetch('https://fal.run/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      'Content-Type': 'application/octet-stream',
      'X-Fal-File-Name': filename,
    },
    body: data,
  });
  if (!res.ok) throw new Error(`fal upload failed: ${res.status}`);
  const json = (await res.json()) as { url: string };
  return json.url;
}

// A small, publicly available product image (a simple PNG from Wikipedia).
const SAMPLE_IMAGE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

// A short public domain sample video (Big Buck Bunny clip, ~1 s, low-res).
const SAMPLE_VIDEO_URL =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4';

// A simple face image (Wikimedia portrait example).
const SAMPLE_FACE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gatto_europeo4.jpg/220px-Gatto_europeo4.jpg';

// ---------------------------------------------------------------------------
// Helpers to fetch remote assets into temp files for upload.
// ---------------------------------------------------------------------------
async function fetchToTmp(url: string, suffix: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sample asset: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `ugc-live-${Date.now()}${suffix}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

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

  it(
    'runs getSwapProvider().swap() on sample video + face image and returns a URL',
    async () => {
      // Download sample assets to temp files so we can upload them to fal storage.
      const videoPath = await fetchToTmp(SAMPLE_VIDEO_URL, '.mp4');
      const facePath = await fetchToTmp(SAMPLE_FACE_URL, '.jpg');

      try {
        const videoUrl = await uploadForUrl(videoPath);
        const imageUrl = await uploadForUrl(facePath);

        const provider = getSwapProvider();
        const resultUrl = await provider.swap({ videoUrl, imageUrl });

        expect(typeof resultUrl).toBe('string');
        expect(resultUrl).toMatch(/^https?:\/\//);
      } finally {
        // Clean up temp files.
        fs.rmSync(videoPath, { force: true });
        fs.rmSync(facePath, { force: true });
      }
    },
    300_000,
  );
});
