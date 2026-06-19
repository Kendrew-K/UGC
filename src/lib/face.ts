import { downloadTo } from './download';

export type FaceSpec = { kind: 'upload'; path: string } | { kind: 'generate'; prompt: string };
export type AvatarGen = (prompt: string) => Promise<string>;

const defaultGenerate: AvatarGen = async (prompt) => {
  const res = await fetch('https://api.bananapro.ai/v1/images', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BANANA_PRO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, size: '1024x1024' }),
  });
  if (!res.ok) throw new Error(`Avatar generation failed: ${res.status}`);
  const data = (await res.json()) as { url?: string; data?: { url: string }[] };
  const url = data.url ?? data.data?.[0]?.url;
  if (!url) throw new Error('Avatar API returned no image url');
  return url;
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
