/**
 * Try-on — dresses the avatar in the client's product before the video swap.
 * The swap model (WAN animate/replace) renders whatever the avatar image
 * wears, so the product must be on the avatar BEFORE swapping or it never
 * appears in the final video.
 * Owns: the image-edit call combining avatar + product photos.
 * Does NOT: upload files (callers pass public URLs) or persist results.
 */

import { runKieTask } from './kie';

export type DressInput = { avatarUrl: string; productUrl: string };
export type DressRunner = (input: DressInput, prompt: string) => Promise<string>;

const PROMPT =
  'Dress the person from the first image in the clothing item shown in the second image, ' +
  'keeping their face, hair, body shape and pose exactly the same. ' +
  'If the item is not clothing, have the person hold or present it naturally instead. ' +
  'Photorealistic, full-body view, neutral studio background.';

// fal's hosted Google image-edit model; accepts multiple input images.
const EDIT_ENDPOINT = 'https://fal.run/fal-ai/nano-banana/edit';

// KIE hosts the same nano-banana edit model; used when SWAP_PROVIDER=kie so
// one env var moves ALL paid calls (upload, edits, swap) to the same account.
const kieRun: DressRunner = ({ avatarUrl, productUrl }, prompt) =>
  runKieTask('google/nano-banana-edit', {
    prompt,
    image_urls: [avatarUrl, productUrl],
    output_format: 'jpeg',
    aspect_ratio: 'auto',
  });

const falRun: DressRunner = async ({ avatarUrl, productUrl }, prompt) => {
  const res = await fetch(EDIT_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_urls: [avatarUrl, productUrl], output_format: 'jpeg' }),
  });
  if (!res.ok) throw new Error(`try-on edit failed: ${res.status}`);
  const data = (await res.json()) as { images?: Array<{ url: string }> };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error('try-on edit returned no image');
  return url;
};

/** Returns a hosted URL of the avatar wearing (or holding) the product. */
export async function dressAvatar(
  input: DressInput,
  deps: { run?: DressRunner } = {}
): Promise<string> {
  const run = deps.run ?? (process.env.SWAP_PROVIDER === 'kie' ? kieRun : falRun);
  return run(input, PROMPT);
}
