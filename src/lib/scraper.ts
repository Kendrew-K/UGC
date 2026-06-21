import { ApifyClient } from 'apify-client';

export type Candidate = {
  url: string;
  views: number;
  downloadUrl: string;
  hasVoice: boolean;
  platform: 'tiktok' | 'reels';
  title?: string;
  hashtags?: string[];
};

export type ApifyRun = (input: { searchQueries: string[] }) => Promise<Candidate[]>;

export function filterViral(items: Candidate[], minViews = 1_000_000): Candidate[] {
  return items
    .filter((i) => i.views >= minViews && i.hasVoice === false)
    .sort((a, b) => b.views - a.views);
}

const defaultRun: ApifyRun = async ({ searchQueries }) => {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run = await client.actor('clockworks/tiktok-scraper').call({
    searchQueries,
    resultsPerPage: 50,
  });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items as Record<string, unknown>[]).map((it) => ({
    url: String(it.webVideoUrl ?? ''),
    views: Number(it.playCount ?? 0),
    downloadUrl: String(it.videoUrl ?? ''),
    hasVoice: Boolean(it.hasVoice ?? false),
    platform: 'tiktok' as const,
    title: it.text ? String(it.text) : undefined,
    hashtags: Array.isArray(it.hashtags)
      ? (it.hashtags as Record<string, unknown>[]).map((h) => String(h.name ?? h))
      : undefined,
  }));
};

export async function findViralVideos(
  searchQueries: string[],
  deps: { run?: ApifyRun } = {}
): Promise<Candidate[]> {
  const run = deps.run ?? defaultRun;
  return filterViral(await run({ searchQueries }));
}
