import fs from 'node:fs';
import path from 'node:path';
import { findViralVideos, findViralPhotos, resolveVideoUrl, type Candidate } from './scraper';
import { distinctifyImage } from './postprocess';
import { downloadTo } from './download';
import { distinctify } from './postprocess';
import { resolveFace } from './face';
import { dressAvatar } from './tryon';
import { rankCandidates } from './evaluator';
import { checkVideoQuality, checkImageQuality, checkAvatarIdentity } from './qc';
import type { PipelineSteps } from './jobs';
import type { Classification } from './classifier';
import { kieUpload } from './kie';
import { describeReferenceVideo, buildGenerationPrompt, describeReferencePhoto, buildPhotoPrompt } from './describe';
import { generateVideoFromImage, generatePhotoFromImage } from './generate';
import ffmpeg from 'fluent-ffmpeg';

/** Maps a local image's dimensions to the closest edit-model output ratio, so
 * a portrait TikTok photo stays portrait (KIE's "auto" squares it off). */
export async function nearestAspectRatio(
  imagePath: string,
  deps: { probe?: (p: string) => Promise<{ width: number; height: number }> } = {}
): Promise<string | undefined> {
  const probe =
    deps.probe ??
    ((p: string) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        ffmpeg.ffprobe(p, (err, data) => {
          const s = data?.streams?.find((x) => x.width && x.height);
          if (err || !s) return reject(err ?? new Error('no image stream'));
          resolve({ width: s.width!, height: s.height! });
        });
      }));
  const RATIOS: Array<[string, number]> = [
    ['1:1', 1], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:4', 3 / 4], ['4:3', 4 / 3],
    ['3:2', 3 / 2], ['2:3', 2 / 3], ['5:4', 5 / 4], ['4:5', 4 / 5], ['21:9', 21 / 9],
  ];
  try {
    const { width, height } = await probe(imagePath);
    const r = width / height;
    return RATIOS.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0];
  } catch {
    return undefined; // fall back to the model's default rather than failing the swap
  }
}

/** Uploads a local file wherever SWAP_PROVIDER points, so all paid traffic
 * (upload + edits + swap) stays on one account. */
function defaultUpload(localPath: string): Promise<string> {
  return process.env.SWAP_PROVIDER === 'kie' ? kieUpload(localPath) : falUpload(localPath);
}

async function falUpload(localPath: string): Promise<string> {
  const data = fs.readFileSync(localPath);
  const fileName = path.basename(localPath);
  const contentType = fileName.endsWith('.mp4')
    ? 'video/mp4'
    : fileName.endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
  // rest.alpha.fal.ai is fal's REST host (rest.fal.run does not resolve —
  // confirmed live 2026-07-05, fal.run is only for model endpoints).
  const initRes = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn', {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
  });
  if (!initRes.ok) {
    // fal's error body carries the actionable reason (e.g. "Exhausted balance.
    // Top up…") — a bare status code sends the client hunting in the wrong place.
    const detail = await initRes.text().catch(() => '');
    throw new Error(`fal upload initiate failed: ${initRes.status} ${detail.slice(0, 200)}`);
  }
  const { upload_url, file_url } = (await initRes.json()) as { upload_url: string; file_url: string };
  const putRes = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: data });
  if (!putRes.ok) throw new Error(`fal upload PUT failed: ${putRes.status}`);
  return file_url;
}

/** Dresses the avatar in the product, verifying the result is still the same
 * person before any expensive swap/generate call runs — the edit model
 * occasionally returns a different person entirely (e.g. the product photo's
 * own model) rather than the avatar wearing the product. One retry is cheap
 * (a single image edit); the alternative is discovering it after a paid
 * WAN/Kling roll. Downloads the dressed avatar to `dressedPath` as a side
 * effect (used by the identity check and kept as a diagnostic artifact). */
async function dressAndVerify(
  args: { avatarUrl: string; productUrl: string; faceImagePath: string; dressedPath: string },
  deps: { dress: typeof dressAvatar; download: typeof downloadTo; checkIdentity: typeof checkAvatarIdentity }
): Promise<string> {
  let lastReason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const dressedUrl = await deps.dress({ avatarUrl: args.avatarUrl, productUrl: args.productUrl });
    const localPath = await deps.download(dressedUrl, args.dressedPath);
    const identity = await deps.checkIdentity(args.faceImagePath, localPath);
    if (identity.pass) return dressedUrl;
    lastReason = identity.reason;
    console.warn(`[pipeline] dress step returned a different person (attempt ${attempt + 1}): ${identity.reason}`);
  }
  throw new Error(`avatar identity check failed: ${lastReason}`);
}

export interface RemakePipelineDeps {
  find: typeof findViralVideos;
  download: typeof downloadTo;
  resolveVideo: typeof resolveVideoUrl;
  describe: typeof describeReferenceVideo;
  generate: typeof generateVideoFromImage;
  process: typeof distinctify;
  uploadForUrl: (localPath: string) => Promise<string>;
  generateFace: typeof resolveFace;
  dress: typeof dressAvatar;
  rank: typeof rankCandidates;
  checkVideo: typeof checkVideoQuality;
  checkIdentity: typeof checkAvatarIdentity;
}

/**
 * Remake mode: the chosen viral clip is a CREATIVE REFERENCE, not footage.
 * The swapping stage describes the clip (5-aspect brief), then shoots a brand
 * new video from the brief + the dressed avatar via image-to-video. No source
 * pixels are reused, so the source-suitability gate is deliberately absent —
 * mirrors, second people and collages in the reference are all fine.
 */
export function buildRemakeSteps(args: {
  searchQueries: string[];
  faceImagePath: string;
  productPhotoPath?: string | null;
  jobId: number;
  product?: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'>;
  /** Accepted for call-site signature parity with the picture builder; generation length is fixed, so it is unused. */
  chosenDurationS?: number;
  deps?: Partial<RemakePipelineDeps>;
}): PipelineSteps {
  const d: RemakePipelineDeps = {
    find: args.deps?.find ?? findViralVideos,
    download: args.deps?.download ?? downloadTo,
    resolveVideo: args.deps?.resolveVideo ?? resolveVideoUrl,
    describe: args.deps?.describe ?? describeReferenceVideo,
    generate: args.deps?.generate ?? generateVideoFromImage,
    process: args.deps?.process ?? distinctify,
    uploadForUrl: args.deps?.uploadForUrl ?? defaultUpload,
    generateFace: args.deps?.generateFace ?? resolveFace,
    dress: args.deps?.dress ?? dressAvatar,
    rank: args.deps?.rank ?? rankCandidates,
    checkVideo: args.deps?.checkVideo ?? checkVideoQuality,
    checkIdentity: args.deps?.checkIdentity ?? checkAvatarIdentity,
  };
  const dir = `media/jobs/${args.jobId}`;
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
      const scored = await d.rank(product, raw);
      if (scored.length === 0) throw new Error('No relevant candidates found after scoring');
      return scored;
    },

    async prepareSource(chosen: Candidate) {
      const sourcePath = `${dir}/source.mp4`;
      const dlUrl = chosen.downloadUrl || await d.resolveVideo(chosen.url);
      await d.download(dlUrl, sourcePath);
      // No source-suitability gate: the clip is only watched, never reused.
      return sourcePath;
    },

    async generate(sourcePath: string) {
      const brief = await d.describe(sourcePath);
      try {
        fs.writeFileSync(`${dir}/brief.json`, JSON.stringify(brief, null, 1));
      } catch {
        // diagnostic artifact only — never fail the job over it
      }
      const prompt = buildGenerationPrompt(brief);
      let imageUrl = await d.uploadForUrl(args.faceImagePath);
      // Same ordering rule as the other modes: the generator renders the
      // reference image verbatim, so the product goes on the avatar first.
      if (args.productPhotoPath) {
        const productUrl = await d.uploadForUrl(args.productPhotoPath);
        imageUrl = await dressAndVerify(
          { avatarUrl: imageUrl, productUrl, faceImagePath: args.faceImagePath, dressedPath: `${dir}/dressed.jpg` },
          { dress: d.dress, download: d.download, checkIdentity: d.checkIdentity }
        );
      }
      const swappedPath = `${dir}/swapped.mp4`;
      // Generation is cheap (~$0.25-0.50/roll) — unlike the swap path, a QC
      // failure buys one automatic re-roll before reverting to approval.
      let lastReason = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const resultUrl = await d.generate({ imageUrl, prompt, durationS: 10 });
        await d.download(resultUrl, swappedPath);
        const qc = await d.checkVideo(swappedPath);
        if (qc.pass) return swappedPath;
        lastReason = qc.reason;
        console.warn(`[pipeline] remake generation QC failed (attempt ${attempt + 1}): ${qc.reason}`);
      }
      throw new Error(`quality check failed: ${lastReason}`);
    },

    async process(swappedPath: string) {
      const finalPath = `${dir}/final.mp4`;
      await d.process(swappedPath, finalPath);
      return finalPath;
    },
  };
}

export interface PictureRemakePipelineDeps {
  find: typeof findViralPhotos;
  rank: typeof rankCandidates;
  download: typeof downloadTo;
  describePhoto: typeof describeReferencePhoto;
  generatePhoto: typeof generatePhotoFromImage;
  processImage: typeof distinctifyImage;
  uploadForUrl: (localPath: string) => Promise<string>;
  dress: typeof dressAvatar;
  checkImage: typeof checkImageQuality;
  checkIdentity: typeof checkAvatarIdentity;
  generateFace: typeof resolveFace;
}

/**
 * Picture remake: the chosen viral PHOTO is a creative reference, not footage.
 * Describe it, then generate a brand-new photo of the dressed avatar in the
 * described scene via image-to-image. No source pixels are reused.
 */
export function buildPictureRemakeSteps(args: {
  searchQueries: string[];
  faceImagePath: string;
  productPhotoPath?: string | null;
  jobId: number;
  product?: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'>;
  /** Accepted for call-site signature parity with the video builder; generation length is fixed, so it is unused. */
  chosenDurationS?: number;
  deps?: Partial<PictureRemakePipelineDeps>;
}): PipelineSteps {
  const d: PictureRemakePipelineDeps = {
    find: args.deps?.find ?? findViralPhotos,
    rank: args.deps?.rank ?? rankCandidates,
    download: args.deps?.download ?? downloadTo,
    describePhoto: args.deps?.describePhoto ?? describeReferencePhoto,
    generatePhoto: args.deps?.generatePhoto ?? generatePhotoFromImage,
    processImage: args.deps?.processImage ?? distinctifyImage,
    uploadForUrl: args.deps?.uploadForUrl ?? defaultUpload,
    dress: args.deps?.dress ?? dressAvatar,
    checkImage: args.deps?.checkImage ?? checkImageQuality,
    checkIdentity: args.deps?.checkIdentity ?? checkAvatarIdentity,
    generateFace: args.deps?.generateFace ?? resolveFace,
  };
  const dir = `media/jobs/${args.jobId}`;
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
      const scored = await d.rank(product, await d.find(args.searchQueries));
      if (scored.length === 0) throw new Error('No relevant photo candidates found after scoring');
      return scored;
    },

    async prepareSource(chosen: Candidate) {
      if (!chosen.downloadUrl) throw new Error('photo candidate has no image URL');
      return d.download(chosen.downloadUrl, `${dir}/source.jpg`);
    },

    async generate(sourcePath: string) {
      const brief = await d.describePhoto(sourcePath);
      try {
        fs.writeFileSync(`${dir}/brief.json`, JSON.stringify(brief, null, 1));
      } catch {
        // diagnostic artifact only — never fail the job over it
      }
      const prompt = buildPhotoPrompt(brief);
      let imageUrl = await d.uploadForUrl(args.faceImagePath);
      // Same ordering rule as the other modes: the generator renders the
      // reference image verbatim, so the product goes on the avatar first.
      if (args.productPhotoPath) {
        const productUrl = await d.uploadForUrl(args.productPhotoPath);
        imageUrl = await dressAndVerify(
          { avatarUrl: imageUrl, productUrl, faceImagePath: args.faceImagePath, dressedPath: `${dir}/dressed.jpg` },
          { dress: d.dress, download: d.download, checkIdentity: d.checkIdentity }
        );
      }
      const aspectRatio = await nearestAspectRatio(sourcePath);
      // Generation is cheap — like the video remake path, a QC failure buys
      // one automatic re-roll before reverting to approval.
      let lastReason = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const resultUrl = await d.generatePhoto({ imageUrl, prompt, aspectRatio });
        const genPath = await d.download(resultUrl, `${dir}/gen.jpg`);
        const qc = await d.checkImage(genPath);
        if (qc.pass) return genPath;
        lastReason = qc.reason;
        console.warn(`[pipeline] picture remake QC failed (attempt ${attempt + 1}): ${qc.reason}`);
      }
      throw new Error(`quality check failed: ${lastReason}`);
    },

    async process(genPath: string) {
      return d.processImage(genPath, `${dir}/final.jpg`);
    },
  };
}

