import ffmpeg from 'fluent-ffmpeg';

export type RunFfmpeg = (input: string, output: string, filter: string, audioFilter: string) => Promise<void>;

export function buildFilter(opts: { hueShift?: number; cropPct?: number; speed?: number } = {}): string {
  const hue = opts.hueShift ?? 8;
  const crop = opts.cropPct ?? 0.96;
  const speed = opts.speed ?? 1.03;
  // Slight color grade, center crop+zoom, minor speed change. The final
  // scale rounds to even dimensions — libx264 rejects odd width/height
  // (confirmed live: "height not divisible by 2 (462x831)").
  return [
    `hue=h=${hue}:s=1.05`,
    `crop=iw*${crop}:ih*${crop}`,
    `scale=trunc(iw/${crop}/2)*2:trunc(ih/${crop}/2)*2`,
    `setpts=${(1 / speed).toFixed(4)}*PTS`,
  ].join(',');
}

/** Audio counterpart of the speed change — without it the sped-up video
 * drifts out of sync with its untouched soundtrack. */
export function buildAudioFilter(opts: { speed?: number } = {}): string {
  const speed = opts.speed ?? 1.03;
  return `atempo=${speed}`;
}

/** Near-lossless re-encode: ffmpeg's default crf 23 visibly degrades the
 * already-soft 720p swap output; crf 18 keeps the distinctify pass invisible. */
export const VIDEO_ENCODE_OPTIONS = ['-crf 18', '-preset slow'];

/** High-quality jpeg (2 on ffmpeg's 2-31 scale, lower = better). */
export const IMAGE_ENCODE_OPTIONS = ['-q:v 2'];

const defaultRun: RunFfmpeg = (input, output, filter, audioFilter) =>
  new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters(filter)
      .audioFilters(audioFilter)
      .outputOptions(VIDEO_ENCODE_OPTIONS)
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });

/** Filter chain for still images: same light hue shift + crop as videos, but
 * no speed change (meaningless for a photo) and no audio. */
export function buildImageFilter(opts: { hueShift?: number; cropPct?: number } = {}): string {
  const hue = opts.hueShift ?? 8;
  const crop = opts.cropPct ?? 0.96;
  return [
    `hue=h=${hue}:s=1.05`,
    `crop=iw*${crop}:ih*${crop}`,
    `scale=trunc(iw/${crop}/2)*2:trunc(ih/${crop}/2)*2`,
  ].join(',');
}

const defaultRunImage = (input: string, output: string, filter: string): Promise<void> =>
  new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters(filter)
      .outputOptions(IMAGE_ENCODE_OPTIONS)
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });

/** Image counterpart of distinctify: light color/crop pass on a photo so
 * reposts don't hash-match the original. */
export async function distinctifyImage(
  inputPath: string,
  outputPath: string,
  deps: { runFfmpeg?: (input: string, output: string, filter: string) => Promise<void> } = {}
): Promise<string> {
  const run = deps.runFfmpeg ?? defaultRunImage;
  await run(inputPath, outputPath, buildImageFilter());
  return outputPath;
}

export async function distinctify(
  inputPath: string,
  outputPath: string,
  deps: { runFfmpeg?: RunFfmpeg } = {}
): Promise<string> {
  const run = deps.runFfmpeg ?? defaultRun;
  await run(inputPath, outputPath, buildFilter(), buildAudioFilter());
  return outputPath;
}
