import { NextResponse } from 'next/server';
import path from 'node:path';
import { resolveVideoUrl } from '@/lib/scraper';

/** Downloads a candidate's video via the scraper sidecar and returns a servable /media URL,
 * since TikTok's own web player is unreliable for some scraped links. */
export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url: string };
    if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 });
    const localPath = await resolveVideoUrl(url);
    const mediaUrl = '/media/' + path.relative('media', localPath).split(path.sep).join('/');
    return NextResponse.json({ url: mediaUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
