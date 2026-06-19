import ffmpeg from 'fluent-ffmpeg';

export type RunFfmpeg = (input: string, output: string, filter: string) => Promise<void>;

export function buildFilter(opts: { hueShift?: number; cropPct?: number; speed?: number } = {}): string {
  const hue = opts.hueShift ?? 8;
  const crop = opts.cropPct ?? 0.96;
  const speed = opts.speed ?? 1.03;
  // Slight color grade, center crop+zoom, minor speed change.
  return [
    `hue=h=${hue}:s=1.05`,
    `crop=iw*${crop}:ih*${crop}`,
    `scale=iw/${crop}:ih/${crop}`,
    `setpts=${(1 / speed).toFixed(4)}*PTS`,
  ].join(',');
}

const defaultRun: RunFfmpeg = (input, output, filter) =>
  new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters(filter)
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });

export async function distinctify(
  inputPath: string,
  outputPath: string,
  deps: { runFfmpeg?: RunFfmpeg } = {}
): Promise<string> {
  const run = deps.runFfmpeg ?? defaultRun;
  await run(inputPath, outputPath, buildFilter());
  return outputPath;
}
