import fs from 'node:fs';
import path from 'node:path';
import { findViralVideos, resolveVideoUrl, type Candidate } from './scraper';
import { downloadTo } from './download';
import { getSwapProvider } from './swap';
import { distinctify } from './postprocess';
import { resolveFace } from './face';
import { rankCandidates } from './evaluator';
import type { PipelineSteps } from './jobs';
import type { Classification } from './classifier';

async function falUpload(localPath: string): Promise<string> {
  const data = fs.readFileSync(localPath);
  const fileName = path.basename(localPath);
  const contentType = fileName.endsWith('.mp4')
    ? 'video/mp4'
    : fileName.endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
  const initRes = await fetch('https://rest.fal.run/storage/upload/initiate?storage_type=fal-cdn', {
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
  resolveVideo: typeof resolveVideoUrl;
  swap: (input: { videoUrl: string; imageUrl: string }) => Promise<string>;
  process: typeof distinctify;
  uploadForUrl: (localPath: string) => Promise<string>;
  generateFace: typeof resolveFace;
  rank: typeof rankCandidates;
}

export function buildSteps(args: {
  searchQueries: string[];
  faceImagePath: string;
  jobId: number;
  product?: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'>;
  deps?: Partial<PipelineDeps>;
}): PipelineSteps {
  const d: PipelineDeps = {
    find: args.deps?.find ?? findViralVideos,
    download: args.deps?.download ?? downloadTo,
    resolveVideo: args.deps?.resolveVideo ?? resolveVideoUrl,
    swap: args.deps?.swap ?? ((input) => getSwapProvider().swap(input)),
    process: args.deps?.process ?? distinctify,
    uploadForUrl: args.deps?.uploadForUrl ?? falUpload,
    generateFace: args.deps?.generateFace ?? resolveFace,
    rank: args.deps?.rank ?? rankCandidates,
  };
  const dir = `media/jobs/${args.jobId}`;

  // Minimal product stub used for relevance scoring when no full classification is available.
  const product: Classification = {
    type: args.product?.type ?? 'product',
    industry: args.product?.industry ?? 'general',
    gender: args.product?.gender ?? 'unisex',
    contentStyle: args.product?.contentStyle ?? 'solo-outfit',
    keywords: args.searchQueries,
    searchQueries: args.searchQueries,
  };

  return {
    async generateFace(prompt: string, destPath: string) {
      return d.generateFace({ kind: 'generate', prompt }, destPath);
    },

    async findCandidates() {
      const raw = await d.find(args.searchQueries);
      // Score and filter for relevance — keeps only clips that match the product/gender.
      const scored = await d.rank(product, raw);
      if (scored.length === 0) throw new Error('No relevant candidates found after scoring');
      return scored;
    },

    async prepareSource(chosen: Candidate) {
      const sourcePath = `${dir}/source.mp4`;
      // The search scraper often omits downloadUrl; fall back to the Python
      // sidecar's resolver, which downloads the video (via video.playAddr)
      // and returns a local file path.
      const dlUrl = chosen.downloadUrl || await d.resolveVideo(chosen.url);
      await d.download(dlUrl, sourcePath);
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
