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
  /** Clip length in whole seconds; 0/absent when the source didn't report it. */
  durationS?: number;
  /** Video thumbnail; lets the ranker SEE the clip (catches collages/compilations
   * whose titles read like normal outfit clips). Signed URL, expires within hours. */
  coverUrl?: string;
  downloadUrl: string;
  /** Photo posts only: every image in the carousel (first one == downloadUrl). */
  imageUrls?: string[];
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
  const stdout = (await runSidecar(['search', searchQuery])).trim();
  try {
    return JSON.parse(stdout) as Candidate[];
  } catch (err) {
    const snippet = stdout.slice(0, 200);
    throw new Error(
      `tiktok_scraper.py returned non-JSON output for search "${searchQuery}": ${snippet}`
    );
  }
};

const defaultSearchPhotos: ScraperSearch = async (searchQuery) => {
  const stdout = (await runSidecar(['search-photos', searchQuery])).trim();
  try {
    return JSON.parse(stdout) as Candidate[];
  } catch {
    throw new Error(
      `tiktok_scraper.py returned non-JSON output for search-photos "${searchQuery}": ${stdout.slice(0, 200)}`
    );
  }
};

const defaultResolve: ScraperResolve = async (tiktokUrl) => {
  const destPath = `media/tmp/${randomUUID()}.mp4`;
  await runSidecar(['resolve', tiktokUrl, destPath]);
  return destPath;
};

/** Shortest clip worth face-swapping — sub-8s clips are over before the
 * product registers (a real 4s candidate slipped through and wasted a swap). */
const MIN_DURATION_S = 8;

/**
 * Keeps only clips with at least `minViews` views, no voice-over, and enough
 * runtime to be usable, deduped by URL (multiple search queries often surface
 * the same viral clip), sorted highest-views first.
 */
export function filterViral(items: Candidate[], minViews = 1_000_000): Candidate[] {
  const seen = new Set<string>();
  const deduped = items.filter((i) => {
    if (seen.has(i.url)) return false;
    seen.add(i.url);
    return true;
  });
  return deduped
    .filter((i) => i.views >= minViews && i.hasVoice === false)
    .filter((i) => (i.durationS ?? MIN_DURATION_S) >= MIN_DURATION_S)
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
  const run = deps.run ?? ((input) => searchAllQueries(input.searchQueries, defaultSearch));
  const all = await run({ searchQueries });
  return pickWithAdaptiveFloor(all, filterViral);
}

/**
 * Photo counterpart of findViralVideos: viral TikTok photo-carousel posts
 * sorted by view count descending. Photos have no soundtrack or runtime, so
 * only the view floor and dedupe apply.
 *
 * @param searchQueries - TikTok search terms (e.g. ["leather jacket outfit"])
 * @param deps.run - injectable runner for tests; defaults to the real sidecar
 */
export async function findViralPhotos(
  searchQueries: string[],
  deps: { run?: (input: { searchQueries: string[] }) => Promise<Candidate[]> } = {}
): Promise<Candidate[]> {
  const run = deps.run ?? ((input) => searchAllQueries(input.searchQueries, defaultSearchPhotos));
  const all = await run({ searchQueries });
  return pickWithAdaptiveFloor(all, filterViralPhotos);
}

/** Dedupes photo posts by URL and keeps those above `minViews`, highest first. */
export function filterViralPhotos(items: Candidate[], minViews = 1_000_000): Candidate[] {
  const seen = new Set<string>();
  return items
    .filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)))
    .filter((i) => i.views >= minViews)
    .sort((a, b) => b.views - a.views);
}

// Spacing between queries so a job's several searches don't hit TikTok as one
// burst (bursts are what trip its rate-throttling into empty/blocked responses).
const QUERY_DELAY_MS = 2000;

// Sequential on purpose: each query spawns a full stealth browser, and
// running several at once starves them into page-load timeouts on
// ordinary laptops. One flaky query shouldn't sink the job either —
// only fail if every query failed.
async function searchAllQueries(queries: string[], search: ScraperSearch): Promise<Candidate[]> {
  const results: Candidate[] = [];
  let lastError: unknown;
  let succeeded = 0;
  for (const [i, q] of queries.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
    try {
      results.push(...(await search(q)));
      succeeded++;
    } catch (err) {
      lastError = err;
    }
  }
  if (succeeded === 0 && lastError) throw lastError;
  return results;
}

// Prefer truly viral posts, but never starve the client of choices: many
// niches (and TikTok's non-personalized search) rarely surface 1M+ posts,
// so step the floor down until there are at least MIN_CHOICES options.
function pickWithAdaptiveFloor(
  all: Candidate[],
  filter: (items: Candidate[], minViews: number) => Candidate[]
): Candidate[] {
  const MIN_CHOICES = 5;
  for (const minViews of [1_000_000, 250_000, 50_000, 0]) {
    const viral = filter(all, minViews);
    if (viral.length >= MIN_CHOICES || minViews === 0) return viral;
  }
  return [];
}
