import { downloadTo } from './download';

export type FaceSpec = { kind: 'upload'; path: string } | { kind: 'generate'; prompt: string };
export type AvatarGen = (prompt: string) => Promise<string>;

// Model string — verify against your KIE dashboard (https://kie.ai/market)
const NANO_BANANA_MODEL = 'nano-banana-pro';

const defaultGenerate: AvatarGen = async (prompt) => {
  const headers = {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const submitRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: NANO_BANANA_MODEL, input: { prompt } }),
  });
  if (!submitRes.ok) throw new Error(`Nano Banana submit failed: ${submitRes.status}`);
  const submitData = (await submitRes.json()) as { code: number; data: { taskId: string } };
  const taskId = submitData.data?.taskId;
  if (!taskId) throw new Error('Nano Banana: no taskId in response');

  // Poll until complete (max ~2.5 min)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers });
    if (!pollRes.ok) throw new Error(`Nano Banana poll failed: ${pollRes.status}`);
    const pollData = (await pollRes.json()) as {
      data: { state: string; resultJson: string; failMsg?: string };
    };
    const d = pollData.data;
    if (d?.state === 'success') {
      const result = JSON.parse(d.resultJson) as { resultUrls: string[] };
      const url = result.resultUrls?.[0];
      if (!url) throw new Error('Nano Banana: no image URL in result');
      return url;
    }
    if (d?.state === 'fail') throw new Error(`Nano Banana failed: ${d.failMsg ?? 'unknown'}`);
  }
  throw new Error('Nano Banana generation timed out');
};

export async function resolveFace(
  spec: FaceSpec,
  destPath: string,
  deps: { generate?: AvatarGen; download?: typeof downloadTo } = {}
): Promise<string> {
  if (spec.kind === 'upload') return spec.path;
  const generate = deps.generate ?? defaultGenerate;
  const download = deps.download ?? downloadTo;
  const url = await generate(spec.prompt);
  return download(url, destPath);
}

/**
 * Generates `count` avatar options from the same prompt so the caller can
 * pick one to save and reuse, instead of committing to a single generation.
 */
export async function generateAvatarOptions(
  prompt: string,
  count: number,
  destDir: string,
  deps: { generate?: AvatarGen; download?: typeof downloadTo } = {}
): Promise<string[]> {
  const generate = deps.generate ?? defaultGenerate;
  const download = deps.download ?? downloadTo;
  const urls = await Promise.all(Array.from({ length: count }, () => generate(prompt)));
  return Promise.all(urls.map((url, i) => download(url, `${destDir}/option-${i}.jpg`)));
}
