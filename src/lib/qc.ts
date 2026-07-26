/**
 * QC gate — inspects swap output for AI-generation artifacts (extra limbs,
 * ghosting, melted textures, items appearing/disappearing) before a job is
 * allowed to reach 'ready'. Judgement is Claude vision over sampled frames.
 *
 * Fails OPEN on any infrastructure error (API down, ffmpeg missing): a WAN
 * swap costs real money and 30-60 minutes, so a QC blip must never discard
 * one — worst case the client sees the bad video, which is today's status quo.
 *
 * Owns: frame sampling + the artifact-judgement call.
 * Does NOT: decide what happens on failure (pipeline retries or reverts).
 */

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import ffmpeg from 'fluent-ffmpeg';

export type QcResult = { pass: boolean; reason: string };
export type FrameExtractor = (videoPath: string) => Promise<string[]>;
export type FrameJudge = (framePaths: string[], prompt: string) => Promise<QcResult>;

type JudgeDeps = { client?: Anthropic; readImage?: (p: string) => string };

const VERDICT_FORMAT = 'Respond ONLY with minified JSON: {"pass":true|false,"reason":"<one line>"}';

/** Judges SWAP OUTPUT for generation artifacts. */
export const ARTIFACT_PROMPT =
  'These are frames sampled in order from ONE AI-generated (person-swapped) UGC video or photo. ' +
  'Check every frame for generation artifacts: extra or missing limbs, garbled anatomy or face, ' +
  'ghosting/double exposure, melted or smeared textures, clothing or objects that appear or ' +
  'disappear between frames, or unwatchable blur. Minor softness is fine — flag only defects a ' +
  `viewer would notice. ${VERDICT_FORMAT}`;

/** Judges the DRESSED AVATAR against the original face photo — catches the
 * try-on edit model swapping in a different person (seen live: it sometimes
 * returns the product photo's own model instead of the client's avatar).
 * Runs before the expensive swap/generate call, so a mismatch is cheap to retry. */
export const IDENTITY_PROMPT =
  'The first image is a reference photo of a person. The second image claims to show the ' +
  'SAME person, now dressed in a different outfit. Compare face shape, eyes, skin tone, hair ' +
  'color/texture and approximate age. Ignore outfit, pose, background and lighting differences. ' +
  `Fail (pass=false) if this looks like a different person. ${VERDICT_FORMAT}`;

function skipped(err: unknown): QcResult {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[qc] skipped: ${msg}`);
  return { pass: true, reason: `qc skipped: ${msg}` };
}

/** Judges sampled frames with Claude vision. Fails open on API/parse errors. */
export async function judgeFrames(framePaths: string[], prompt: string, deps: JudgeDeps = {}): Promise<QcResult> {
  const client = deps.client ?? new Anthropic();
  const readImage = deps.readImage ?? ((p: string) => fs.readFileSync(p).toString('base64'));
  try {
    const blocks: Anthropic.ContentBlockParam[] = [{ type: 'text', text: prompt }];
    for (const p of framePaths) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: readImage(p) },
      });
    }
    const res = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 256,
      messages: [{ role: 'user', content: blocks }],
    });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return skipped('unparseable judge reply');
    const verdict = JSON.parse(json) as { pass?: boolean; reason?: string };
    if (typeof verdict.pass !== 'boolean') return skipped('judge reply missing pass field');
    return { pass: verdict.pass, reason: verdict.reason ?? '' };
  } catch (err) {
    return skipped(err);
  }
}

/** Samples `count` frames evenly across the video, first-to-last. Shared by the
 * QC gates (4 frames — drift and end-of-clip ghosting) and the reference-video
 * describe step (more frames — motion needs temporal resolution). */
export function extractFrames(videoPath: string, count = 4): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    // 1%..99% rather than 0%..100%: exact endpoints can land past the last
    // decodable frame and make ffmpeg emit nothing for that timestamp.
    const timestamps = Array.from({ length: count }, (_, i) => `${Math.round(1 + (98 * i) / (count - 1))}%`);
    ffmpeg(videoPath)
      .screenshots({ timestamps, filename: `${base}-qc-%i.jpg`, folder: dir })
      .on('end', () => resolve(timestamps.map((_, i) => path.join(dir, `${base}-qc-${i + 1}.jpg`))))
      .on('error', reject);
  });
}

const defaultExtract: FrameExtractor = (videoPath) => extractFrames(videoPath, 4);

type VideoCheckDeps = { extract?: FrameExtractor; judge?: FrameJudge };

async function checkVideoFrames(videoPath: string, prompt: string, deps: VideoCheckDeps): Promise<QcResult> {
  const extract = deps.extract ?? defaultExtract;
  const judge = deps.judge ?? judgeFrames;
  let frames: string[];
  try {
    frames = await extract(videoPath);
  } catch (err) {
    return skipped(err);
  }
  try {
    return await judge(frames, prompt);
  } finally {
    for (const f of frames) fs.rmSync(f, { force: true });
  }
}

/** QC for a swapped video: sample 4 frames, judge for generation artifacts. */
export function checkVideoQuality(videoPath: string, deps: VideoCheckDeps = {}): Promise<QcResult> {
  return checkVideoFrames(videoPath, ARTIFACT_PROMPT, deps);
}

/** QC for a swapped photo: judge the single image for generation artifacts. */
export function checkImageQuality(
  imagePath: string,
  deps: { judge?: FrameJudge } = {}
): Promise<QcResult> {
  return (deps.judge ?? judgeFrames)([imagePath], ARTIFACT_PROMPT);
}

/** QC for the dressed avatar: same person as the source face photo? */
export function checkAvatarIdentity(
  facePath: string,
  dressedPath: string,
  deps: { judge?: FrameJudge } = {}
): Promise<QcResult> {
  return (deps.judge ?? judgeFrames)([facePath, dressedPath], IDENTITY_PROMPT);
}
