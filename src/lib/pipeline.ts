import fs from 'node:fs';
import path from 'node:path';
import { findViralVideos, type Candidate } from './scraper';
import { downloadTo } from './download';
import { getSwapProvider } from './swap';
import { distinctify } from './postprocess';
import { resolveFace } from './face';
import type { PipelineSteps } from './jobs';

/**
 * Upload a local file to fal's storage CDN and return a publicly-reachable URL,
 * so WAN-based swap providers can fetch the source video and face image.
 */
async function falUpload(localPath: string): Promise<string> {
  const data = fs.readFileSync(localPath);
  const fileName = path.basename(localPath);
  const contentType = fileName.endsWith('.mp4')
    ? 'video/mp4'
    : fileName.endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
  const initRes = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn', {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
  });
  if (!initRes.ok) throw new Error(`fal upload initiate failed: ${initRes.status}`);
  const { upload_url, file_url } = (await initRes.json()) as { upload_url: string; file_url: string };
  const putRes = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: data });
  if (!putRes.ok) throw new Error(`fal upload PUT failed: ${putRes.status}`);
  return file_url;
}

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
   * swap providers can fetch it. Defaults to uploading to fal's storage CDN.
   */
  uploadForUrl: (localPath: string) => Promise<string>;
  /** Generate an AI avatar image from a text prompt and save it to destPath. */
  generateFace: typeof resolveFace;
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
    uploadForUrl: args.deps?.uploadForUrl ?? falUpload,
    generateFace: args.deps?.generateFace ?? resolveFace,
  };
  const dir = `media/jobs/${args.jobId}`;

  return {
    async generateFace(prompt: string, destPath: string) {
      return d.generateFace({ kind: 'generate', prompt }, destPath);
    },

    async findCandidates() {
      return d.find(args.keywords);
    },

    async prepareSource(chosen: Candidate) {
      const sourcePath = `${dir}/source.mp4`;
      await d.download(chosen.downloadUrl, sourcePath);
      return sourcePath;
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
