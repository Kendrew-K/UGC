import { findViralVideos } from './scraper';
import { downloadTo } from './download';
import { getSwapProvider } from './swap';
import { distinctify } from './postprocess';
import type { PipelineSteps } from './jobs';

export interface PipelineDeps {
  find: typeof findViralVideos;
  download: typeof downloadTo;
  /**
   * Calls a swap provider. Receives publicly-reachable URLs for the source
   * video and face image, returns a remote URL for the swapped result.
   */
  swap: (input: { videoUrl: string; imageUrl: string }) => Promise<string>;
  process: typeof distinctify;
  /**
   * Converts a local file path to a publicly-reachable URL so that WAN-based
   * swap providers can fetch it.
   *
   * Default (v1): passthrough — returns the path unchanged. This is intentional
   * for local development and unit tests. Before the live pipeline works
   * end-to-end, this must be replaced with a real upload (e.g. fal/Replicate
   * file-upload endpoint or a signed temporary host). Flagged for Task 14.
   */
  uploadForUrl: (localPath: string) => Promise<string>;
}

export function buildSteps(args: {
  keywords: string[];
  faceImagePath: string;
  jobId: number;
  deps?: Partial<PipelineDeps>;
}): PipelineSteps {
  const d: PipelineDeps = {
    find: args.deps?.find ?? findViralVideos,
    download: args.deps?.download ?? downloadTo,
    swap: args.deps?.swap ?? ((input) => getSwapProvider().swap(input)),
    process: args.deps?.process ?? distinctify,
    // v1 passthrough — see PipelineDeps.uploadForUrl JSDoc above
    uploadForUrl: args.deps?.uploadForUrl ?? (async (p) => p),
  };
  const dir = `media/jobs/${args.jobId}`;

  return {
    async scrape() {
      const candidates = await d.find(args.keywords);
      if (candidates.length === 0) throw new Error('No viral candidates found');
      const sourcePath = `${dir}/source.mp4`;
      await d.download(candidates[0].downloadUrl, sourcePath);
      return { sourcePath, candidates };
    },

    async swap(sourcePath: string) {
      const videoUrl = await d.uploadForUrl(sourcePath);
      const imageUrl = await d.uploadForUrl(args.faceImagePath);
      const resultUrl = await d.swap({ videoUrl, imageUrl });
      const swappedPath = `${dir}/swapped.mp4`;
      await d.download(resultUrl, swappedPath);
      return swappedPath;
    },

    async process(swappedPath: string) {
      const finalPath = `${dir}/final.mp4`;
      await d.process(swappedPath, finalPath);
      return finalPath;
    },
  };
}
