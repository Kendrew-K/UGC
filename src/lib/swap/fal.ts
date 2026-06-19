import type { SwapProvider, SwapInput } from './types';

// fal-ai/wan/v2.2-14b/animate/replace — submit, poll, fetch.
export const falProvider: SwapProvider = {
  async swap({ videoUrl, imageUrl }: SwapInput): Promise<string> {
    const res = await fetch('https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace', {
      method: 'POST',
      headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: videoUrl, image_url: imageUrl }),
    });
    if (!res.ok) throw new Error(`fal submit failed: ${res.status}`);
    const { status_url } = (await res.json()) as { status_url: string };
    // Poll until completed.
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetch(status_url, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
      const body = (await s.json()) as { status: string; response_url?: string };
      if (body.status === 'COMPLETED' && body.response_url) {
        const out = await fetch(body.response_url, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
        const data = (await out.json()) as { video?: { url: string } };
        if (!data.video?.url) throw new Error('fal returned no video url');
        return data.video.url;
      }
      if (body.status === 'FAILED') throw new Error('fal job failed');
    }
  },
};
