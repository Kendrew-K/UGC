import type { SwapProvider, SwapInput } from './types';

// KIE.AI WAN 2.2 Animate Replace — submit task, poll recordInfo until success.
export const kieProvider: SwapProvider = {
  async swap({ videoUrl, imageUrl }: SwapInput): Promise<string> {
    const headers = {
      Authorization: `Bearer ${process.env.KIE_API_KEY}`,
      'Content-Type': 'application/json',
    };

    const submitRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'wan/2-2-animate-replace',
        input: { video_url: videoUrl, image_url: imageUrl, resolution: '480p' },
      }),
    });
    if (!submitRes.ok) throw new Error(`KIE swap submit failed: ${submitRes.status}`);
    const submitData = (await submitRes.json()) as { code: number; data: { taskId: string } };
    const taskId = submitData.data?.taskId;
    if (!taskId) throw new Error('KIE swap: no taskId in response');

    // Poll until success or failure (max ~5 min)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers });
      if (!pollRes.ok) throw new Error(`KIE swap poll failed: ${pollRes.status}`);
      const pollData = (await pollRes.json()) as {
        data: { state: string; resultJson: string; failMsg?: string };
      };
      const d = pollData.data;
      if (d?.state === 'success') {
        const result = JSON.parse(d.resultJson) as { resultUrls: string[] };
        const url = result.resultUrls?.[0];
        if (!url) throw new Error('KIE swap: no video URL in result');
        return url;
      }
      if (d?.state === 'fail') throw new Error(`KIE swap failed: ${d.failMsg ?? 'unknown'}`);
    }
    throw new Error('KIE swap timed out');
  },
};
