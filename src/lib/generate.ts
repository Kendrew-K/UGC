/**
 * Media generation — the "shoot" half of remake mode: turns the dressed
 * avatar photo + a brief-derived prompt into a brand-new UGC clip via KIE's
 * image-to-video API. No source pixels are reused, so none of the swap
 * pipeline's source constraints (mirrors, second people, collages) apply.
 * Owns: the single i2v call.
 * Does NOT: build prompts (describe.ts), upload files, or run QC.
 */
import { runKieTask } from './kie';

// kling-2.6/image-to-video — verified live 2026-07-10 via empty-input probe
// (validation error, vs 422 "model not supported" for bogus slugs).
const DEFAULT_I2V_MODEL = 'kling-2.6/image-to-video';

export type GenerateInput = { imageUrl: string; prompt: string; durationS?: number };

/** Returns a hosted URL of the generated clip. */
export function generateVideoFromImage(
  input: GenerateInput,
  deps: { run?: typeof runKieTask } = {}
): Promise<string> {
  const run = deps.run ?? runKieTask;
  const model = process.env.KIE_I2V_MODEL || DEFAULT_I2V_MODEL;
  return run(model, {
    image_urls: [input.imageUrl],
    prompt: input.prompt,
    // Kling takes a "5"|"10" enum, not free seconds — anything past 5s costs
    // the 10s tier anyway, so round up.
    duration: (input.durationS ?? 10) <= 5 ? '5' : '10',
    // Viral-clip audio never survives a remake; music is added at posting time.
    sound: false,
  });
}

// KIE-hosted Google image-edit model; a single input image + a scene prompt
// re-shoots the avatar into a described setting (generation, not a swap).
const DEFAULT_IMAGE_MODEL = 'google/nano-banana-edit';

export type GeneratePhotoInput = { imageUrl: string; prompt: string; aspectRatio?: string };

/** Returns a hosted URL of a newly generated photo of the avatar in the described scene. */
export function generatePhotoFromImage(
  input: GeneratePhotoInput,
  deps: { run?: typeof runKieTask } = {}
): Promise<string> {
  const run = deps.run ?? runKieTask;
  const model = process.env.KIE_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  return run(model, {
    prompt: input.prompt,
    image_urls: [input.imageUrl],
    output_format: 'jpeg',
    aspect_ratio: input.aspectRatio ?? 'auto',
  });
}
