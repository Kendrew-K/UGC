import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveVideoUrl } from '@/lib/scraper';

// TikTok's embed player can't stream in an iframe (the CDN needs first-party
// cookies), so previewing means downloading the clip through the scraper's
// own browser session and serving the local file. Downloads take ~30s, so
// cache by post URL. ponytail: in-memory cache, dev-server restarts refetch.
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

async function download(url: string): Promise<string> {
  const localPath = await resolveVideoUrl(url);
  return '/media/' + path.relative('media', localPath).split(path.sep).join('/');
}

export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url: string };
    if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 });

    const cached = cache.get(url);
    if (cached && existsSync(path.join('media', cached.replace(/^\/media\//, '')))) {
      return NextResponse.json({ url: cached });
    }

    // Share one download between double-clicks / re-opened modals.
    let pending = inFlight.get(url);
    if (!pending) {
      pending = download(url).finally(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }
    const mediaUrl = await pending;
    cache.set(url, mediaUrl);
    return NextResponse.json({ url: mediaUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
