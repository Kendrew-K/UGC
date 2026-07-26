/**
 * Reference-video describe step — the analysis half of "remake" mode: instead
 * of swapping pixels in a viral clip, watch the clip and write a structured
 * creative brief a video-generation model can shoot from, with the client's
 * dressed avatar as the subject.
 *
 * The brief uses the 5-aspect breakdown (Subject / Subject Motion / Scene /
 * Spatial Framing / Camera) — the captioning structure video-gen models are
 * trained against (concept borrowed from OpenMontage's video-reference-analyst
 * stage; implementation is our own). Two rules matter most:
 *  - every aspect is answered or explicitly "N/A" — silent omission produces
 *    ambiguous generation prompts;
 *  - overlays (burned-in text/graphics) are described separately from the
 *    setting so they can be deliberately dropped from the remake.
 *
 * Fails CLOSED: a wrong brief silently produces a wrong (paid) video, so any
 * parse/validation problem throws instead of guessing.
 *
 * Owns: frame sampling + the brief call + generation-prompt composition.
 * Does NOT: download video, pick candidates, or call the video generator.
 */

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { extractFrames } from './qc';

export type VideoBrief = {
  summary: string;
  subject: { description: string; outfitStyle: string };
  /** Actions in temporal order with rough timestamps. */
  beats: Array<{ t: string; action: string }>;
  scene: { setting: string; timeOfDay: string; overlays: string; dynamics: string };
  spatialFraming: { shotSize: string; subjectPosition: string; depth: string };
  camera: { movement: string; angle: string; steadiness: string; speed: string };
  lighting: { direction: string; quality: string };
  colorGrade: string;
  skinTexture: string;
  pacing: string;
  whatMakesItWork: string[];
  /** Concrete ways the remake should differ from the reference (setting shifts, added beats). */
  differentiationSeeds: string[];
};

const REQUIRED_KEYS: Array<keyof VideoBrief> = [
  'summary', 'subject', 'beats', 'scene', 'spatialFraming', 'camera',
  'lighting', 'colorGrade', 'skinTexture', 'pacing', 'whatMakesItWork', 'differentiationSeeds',
];

const DESCRIBE_PROMPT =
  'These are frames sampled in temporal order from ONE short-form (TikTok-style) UGC video. ' +
  'Analyze it as a reference for re-shooting a similar video with a different person. ' +
  'For EVERY field: answer it, or write exactly "N/A" — never omit. Describe burned-in text/graphics ' +
  'ONLY in scene.overlays. Capture lighting, color grade and skin texture precisely — they drive realism. ' +
  'differentiationSeeds: 3 concrete ways a remake should differ; the FIRST must be an alternative setting ' +
  '(prefer plain/indoor/studio backdrops). Respond ONLY with minified JSON exactly matching: ' +
  '{"summary":"2 sentences","subject":{"description":"","outfitStyle":""},' +
  '"beats":[{"t":"0s","action":""}],' +
  '"scene":{"setting":"","timeOfDay":"","overlays":"","dynamics":""},' +
  '"spatialFraming":{"shotSize":"","subjectPosition":"","depth":""},' +
  '"camera":{"movement":"","angle":"","steadiness":"","speed":""},' +
  '"lighting":{"direction":"","quality":""},"colorGrade":"","skinTexture":"",' +
  '"pacing":"","whatMakesItWork":["3 items"],"differentiationSeeds":["3 items"]}';

export type DescribeDeps = {
  extract?: (videoPath: string, count: number) => Promise<string[]>;
  client?: Anthropic;
  readImage?: (p: string) => string;
};

/** Watches a downloaded reference clip and returns its structured 5-aspect brief. */
export async function describeReferenceVideo(videoPath: string, deps: DescribeDeps = {}): Promise<VideoBrief> {
  const extract = deps.extract ?? extractFrames;
  const client = deps.client ?? new Anthropic();
  const readImage = deps.readImage ?? ((p: string) => fs.readFileSync(p).toString('base64'));

  // 14 frames: QC's 4 are enough to spot artifacts, but motion ("turns, then
  // poses, then walks off") needs finer temporal resolution to order beats.
  const frames = await extract(videoPath, 14);
  try {
    const blocks: Anthropic.ContentBlockParam[] = [{ type: 'text', text: DESCRIBE_PROMPT }];
    for (const p of frames) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readImage(p) } });
    }
    const res = await client.messages.create({
      model: 'claude-opus-4-8',
      // 2048, not 1024: the enriched brief (11+ beats + lighting/color/texture)
      // overran 1024 and truncated to unparseable JSON (job 35 re-run failure).
      max_tokens: 2048,
      messages: [{ role: 'user', content: blocks }],
    });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('reference video brief: model returned no JSON');
    let brief: VideoBrief;
    try {
      brief = JSON.parse(json) as VideoBrief;
    } catch {
      throw new Error('reference video brief: unparseable JSON');
    }
    const missing = REQUIRED_KEYS.filter((k) => brief[k] == null);
    if (missing.length > 0) throw new Error(`reference video brief missing: ${missing.join(', ')}`);
    return brief;
  } finally {
    for (const f of frames) fs.rmSync(f, { force: true });
  }
}

// The generator renders a fixed ~10s clip; a reference brief often has far more
// beats than that (job 35: 11 beats over 27s). Cramming them all in makes the
// model rush and morph props ("applicator appears from nowhere"), so we keep
// only the opening beats that fit the clip length.
// ponytail: fixed cap tuned to the 10s Kling roll; make it a arg if durations vary.
const MAX_GENERATION_BEATS = 5;

/**
 * Composes the image-to-video generation prompt from a brief. The subject's
 * identity and outfit come from the dressed-avatar reference image the
 * generator receives — the brief's subject description is deliberately
 * dropped, and the original setting is replaced by the first differentiation
 * seed so the remake is not a pixel-for-pixel copy.
 */
export function buildGenerationPrompt(brief: VideoBrief): string {
  const beats = brief.beats.slice(0, MAX_GENERATION_BEATS);
  return [
    `The person in the reference image, wearing exactly the outfit shown in it.`,
    `Motion, in order: ${beats.map((b) => `${b.t} ${b.action}`).join('; ')}.`,
    `Setting: ${brief.differentiationSeeds[0]}.`,
    `Framing: ${brief.spatialFraming.shotSize}, subject ${brief.spatialFraming.subjectPosition}, ${brief.spatialFraming.depth}.`,
    `Camera: ${brief.camera.movement}, ${brief.camera.angle}, ${brief.camera.steadiness}, ${brief.camera.speed}.`,
    `Lighting: ${brief.lighting.direction}, ${brief.lighting.quality}. Color grade: ${brief.colorGrade}.`,
    `Pacing: ${brief.pacing}.`,
    // Product-consistency clause: the swap-free generator invents/morphs held
    // objects (job 35 QC: "lipstick morphs, applicator appears from nowhere").
    `Any product she holds keeps one consistent shape, color and size throughout; no new objects appear in her hands.`,
    `Photorealistic vertical UGC video. Natural human skin with visible pores (${brief.skinTexture}), soft directional light, subtle film grain, slight handheld micro-shake, no plastic/AI sheen, no on-screen text or graphics.`,
  ].join(' ');
}

/**
 * Single-frame counterpart of {@link VideoBrief} for the picture pipeline:
 * one reference photo instead of a clip, so there is no `beats` timeline and
 * no `camera` aspect (a still has no movement/angle/steadiness/speed).
 */
export type PhotoBrief = {
  summary: string;
  subject: { description: string; outfitStyle: string };
  scene: { setting: string; timeOfDay: string; overlays: string };
  spatialFraming: { shotSize: string; subjectPosition: string; depth: string };
  lighting: { direction: string; quality: string };
  colorGrade: string;
  skinTexture: string;
  whatMakesItWork: string[];
  differentiationSeeds: string[];
};

const PHOTO_REQUIRED_KEYS: Array<keyof PhotoBrief> = [
  'summary', 'subject', 'scene', 'spatialFraming', 'lighting', 'colorGrade',
  'skinTexture', 'whatMakesItWork', 'differentiationSeeds',
];

const DESCRIBE_PHOTO_PROMPT =
  'This is ONE viral short-form (TikTok-style) UGC PHOTO post. Analyze it as a reference for ' +
  're-shooting a similar photo with a different person. For EVERY field: answer it, or write exactly ' +
  '"N/A". Describe burned-in text/graphics ONLY in scene.overlays. Capture lighting, color grade and ' +
  'skin texture precisely — they drive realism. differentiationSeeds: 3 concrete ways a remake should ' +
  'differ; the FIRST must be an alternative setting (prefer plain/indoor/studio). Respond ONLY with ' +
  'minified JSON exactly matching: {"summary":"2 sentences","subject":{"description":"","outfitStyle":""},' +
  '"scene":{"setting":"","timeOfDay":"","overlays":""},' +
  '"spatialFraming":{"shotSize":"","subjectPosition":"","depth":""},' +
  '"lighting":{"direction":"","quality":""},"colorGrade":"","skinTexture":"",' +
  '"whatMakesItWork":["3 items"],"differentiationSeeds":["3 items"]}';

/** Reads a single downloaded reference photo and returns its structured brief. */
export async function describeReferencePhoto(
  photoPath: string,
  deps: { client?: Anthropic; readImage?: (p: string) => string } = {}
): Promise<PhotoBrief> {
  const client = deps.client ?? new Anthropic();
  const readImage = deps.readImage ?? ((p: string) => fs.readFileSync(p).toString('base64'));
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: DESCRIBE_PHOTO_PROMPT },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readImage(photoPath) } },
  ];
  const res = await client.messages.create({ model: 'claude-opus-4-8', max_tokens: 2048, messages: [{ role: 'user', content: blocks }] });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('reference photo brief: model returned no JSON');
  let brief: PhotoBrief;
  try {
    brief = JSON.parse(json) as PhotoBrief;
  } catch {
    throw new Error('reference photo brief: unparseable JSON');
  }
  const missing = PHOTO_REQUIRED_KEYS.filter((k) => brief[k] == null);
  if (missing.length > 0) throw new Error(`reference photo brief missing: ${missing.join(', ')}`);
  return brief;
}

/** Composes the image-edit generation prompt for a picture remake. */
export function buildPhotoPrompt(brief: PhotoBrief): string {
  return [
    `The person in the reference image, wearing exactly the outfit shown in it.`,
    `Setting: ${brief.differentiationSeeds[0]}.`,
    `Framing: ${brief.spatialFraming.shotSize}, subject ${brief.spatialFraming.subjectPosition}, ${brief.spatialFraming.depth}.`,
    `Lighting: ${brief.lighting.direction}, ${brief.lighting.quality}. Color grade: ${brief.colorGrade}.`,
    `Photorealistic vertical UGC photo. Natural human skin with visible pores (${brief.skinTexture}), soft directional light, subtle film grain, no plastic/AI sheen, no on-screen text or graphics.`,
  ].join(' ');
}
