import type { SwapProvider, SwapInput } from './types';

// wan-video/wan-2.2-animate-replace on Replicate — create prediction, poll.
export const replicateProvider: SwapProvider = {
  async swap({ videoUrl, imageUrl }: SwapInput): Promise<string> {
    const res = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({
        version: 'wan-video/wan-2.2-animate-replace',
        input: { video: videoUrl, image: imageUrl },
      }),
    });
    if (!res.ok) throw new Error(`replicate submit failed: ${res.status}`);
    let pred = (await res.json()) as { status: string; output?: string | string[]; urls?: { get: string } };
    while (pred.status !== 'succeeded' && pred.status !== 'failed') {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetch(pred.urls!.get, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      pred = (await s.json()) as typeof pred;
    }
    if (pred.status === 'failed') throw new Error('replicate job failed');
    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!out) throw new Error('replicate returned no output');
    return out;
  },
};
