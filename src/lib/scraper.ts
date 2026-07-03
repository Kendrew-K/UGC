/**
 * Scraper — finds viral TikTok clips via a Python sidecar (Scrapling-based)
 * that scrapes TikTok's search/video pages directly.
 * Owns: search query execution, raw item mapping, virality filtering.
 * Does NOT: evaluate relevance or persist results.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Candidate = {
  url: string;
  views: number;
  downloadUrl: string;
  hasVoice: boolean;
  platform: 'tiktok' | 'reels';
  title?: string;
  hashtags?: string[];
};

export type ScraperSearch = (searchQuery: string) => Promise<Candidate[]>;
export type ScraperResolve = (tiktokUrl: string) => Promise<string>;

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python';
const SIDECAR_PATH = 'python/tiktok_scraper.py';

async function runSidecar(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [SIDECAR_PATH, ...args]);
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    throw new Error(`tiktok_scraper.py failed: ${stderr || (err as Error).message}`);
  }
}

const defaultSearch: ScraperSearch = async (searchQuery) => {
  const stdout = await runSidecar(['search', searchQuery]);
  return JSON.parse(stdout) as Candidate[];
};

const defaultResolve: ScraperResolve = async (tiktokUrl) => {
  const destPath = `media/tmp/${randomUUID()}.mp4`;
  await runSidecar(['resolve', tiktokUrl, destPath]);
  return destPath;
};

/**
 * Keeps only clips with at least `minViews` views and no voice-over,
 * sorted highest-views first.
 */
export function filterViral(items: Candidate[], minViews = 1_000_000): Candidate[] {
  return items
    .filter((i) => i.views >= minViews && i.hasVoice === false)
    .sort((a, b) => b.views - a.views);
}

/**
 * Resolves a local file path for a TikTok post URL by downloading the video
 * via the Python sidecar (avoids cross-process cookie/session mismatches
 * that plague raw CDN URLs fetched from a separate process).
 *
 * @param tiktokUrl - The full TikTok post URL (e.g. https://www.tiktok.com/@user/video/123)
 * @param deps.resolve - injectable resolver for tests; defaults to the real sidecar
 */
export async function resolveVideoUrl(
  tiktokUrl: string,
  deps: { resolve?: ScraperResolve } = {}
): Promise<string> {
  const resolve = deps.resolve ?? defaultResolve;
  return resolve(tiktokUrl);
}

/**
 * Runs `searchQueries` through the Python sidecar and returns viral,
 * voice-free candidates sorted by view count descending.
 *
 * @param searchQueries - TikTok search terms (e.g. ["men fit check jacket"])
 * @param deps.run - injectable runner for tests; defaults to the real sidecar
 */
export async function findViralVideos(
  searchQueries: string[],
  deps: { run?: (input: { searchQueries: string[] }) => Promise<Candidate[]> } = {}
): Promise<Candidate[]> {
  const run =
    deps.run ??
    (async ({ searchQueries: queries }) => {
      const results = await Promise.all(queries.map((q) => defaultSearch(q)));
      return results.flat();
    });
  return filterViral(await run({ searchQueries }));
}
