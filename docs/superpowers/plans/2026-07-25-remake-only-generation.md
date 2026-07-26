# Remake-Only Generation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire face-swap entirely and make generation-from-description the only path for both video and picture output, with looser candidate filtering, richer descriptions, and realism-tuned prompts.

**Architecture:** The viral clip/photo is a *creative reference only* — it is described, never reused pixel-for-pixel. Both modes dress the chosen avatar in the product, describe the reference, build a realism-tuned prompt, and generate brand-new media (Kling image-to-video for video; nano-banana image edit on the avatar for pictures). No source-suitability gate; output QC + one auto-reroll only.

**Tech Stack:** Next.js 16 (App Router, TypeScript strict), better-sqlite3, Anthropic SDK (Claude vision), KIE/fal hosted models (Kling i2v, nano-banana edit), fluent-ffmpeg, Vitest.

## Global Constraints

- TypeScript strict; no `any` in new non-test code.
- All third-party API calls stay inside `src/lib/` modules; routes/UI never call them directly.
- Every `src/lib` module takes a `deps` object with injectable defaults, so tests mock without network. Follow the existing pattern exactly.
- Fail CLOSED on description parse/validation (a wrong brief burns a paid generation); fail OPEN on QC infra errors (never discard a paid roll over an API blip).
- Models chosen by env, never hardcoded at a call site where an override already exists (`KIE_I2V_MODEL`, `SWAP_PROVIDER`).
- `npm test` (vitest) and `npx tsc --noEmit` must be green at the end of every task.
- Commit after every task. Do NOT push. (Repo rule: commit only these plan-defined checkpoints.)

---

### Task 1: Loosen candidate filtering to industry/activity match

**Files:**
- Modify: `src/lib/evaluator.ts`
- Modify: `src/lib/evaluator.test.ts`
- Modify: `src/lib/pipeline.ts` (buildRemakeSteps `rank` call — drop the `mode` arg)

**Interfaces:**
- Consumes: `Classification` (`./classifier`), `Candidate` (`./scraper`).
- Produces: `rankCandidates(product, candidates, deps?) => Promise<ScoredCandidate[]>` — the `opts.mode` parameter is REMOVED. `MAX_CLIP_SECONDS` export is REMOVED. `MIN_SCORE` lowered to `3`.

- [ ] **Step 1: Write the failing test**

Replace the mode-specific tests in `src/lib/evaluator.test.ts` with a single-rubric set. Add/replace these cases (keep the existing mocked-Anthropic harness the file already uses):

```ts
it('keeps a mirror/second-person clip (no longer swap-gated)', async () => {
  const candidates = [
    { url: 'a', views: 2_000_000, coverUrl: 'http://c/a.jpg', downloadUrl: 'da' },
  ] as Candidate[];
  const client = fakeClient('[{"index":0,"score":8,"reason":"makeup, mirror ok"}]');
  const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
  expect(out).toHaveLength(1);
  expect(out[0].relevanceScore).toBe(8);
});

it('does not filter by clip length', async () => {
  const candidates = [
    { url: 'a', views: 2_000_000, durationS: 45, downloadUrl: 'da' },
  ] as Candidate[];
  const client = fakeClient('[{"index":0,"score":7,"reason":"long but fine"}]');
  const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
  expect(out).toHaveLength(1); // 45s clip survives — no MAX_CLIP_SECONDS cut
});

it('drops candidates below MIN_SCORE (3)', async () => {
  const candidates = [
    { url: 'a', views: 2_000_000, downloadUrl: 'da' },
    { url: 'b', views: 2_000_000, downloadUrl: 'db' },
  ] as Candidate[];
  const client = fakeClient('[{"index":0,"score":2,"reason":"collage"},{"index":1,"score":3,"reason":"ok"}]');
  const out = await rankCandidates(product('lipstick', 'beauty', 'female'), candidates, { client });
  expect(out.map((c) => c.url)).toEqual(['b']);
});
```

If the file lacks `fakeClient`/`product` helpers, add them at the top:

```ts
function fakeClient(text: string) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } } as unknown as Anthropic;
}
function product(type: string, industry: string, gender: string): Classification {
  return { type, industry, gender: gender as Classification['gender'], contentStyle: 'solo-outfit', keywords: [type], searchQueries: [type] };
}
```

Delete any existing test that asserts `mode: 'swap'` behavior, the `MAX_CLIP_SECONDS` filter, or exact-product-type rejection.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/evaluator.test.ts`
Expected: FAIL (e.g. `rankCandidates` still expects `opts.mode`, or `MAX_CLIP_SECONDS` referenced).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/evaluator.ts`:
- Delete the `export const MAX_CLIP_SECONDS = 20;` block and the `if (mode === 'swap') { candidates = candidates.filter(...) }` block.
- Change `const MIN_SCORE = 4;` to `const MIN_SCORE = 3;`.
- Change the signature to drop `opts`:

```ts
export async function rankCandidates(
  product: Classification,
  candidates: Candidate[],
  deps: { client?: Anthropic } = {}
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];
  const client = deps.client ?? new Anthropic();
```

- Replace the `swapRubric`/`remakeRubric`/`header` block with ONE rubric:

```ts
  const header =
    `Product: ${product.type} | gender: ${product.gender} | style: ${product.contentStyle} | industry: ${product.industry}\n\n` +
    `Rate each TikTok/Reels clip as CREATIVE REFERENCE for making a new ${product.industry} video with a different AI person. Score 0-10.\n` +
    `Match at INDUSTRY/ACTIVITY level, not exact product: any viral ${product.industry} clip showing the right activity is a strong reference even if the exact item differs.\n` +
    `10 = a person doing appealing, imitable ${product.industry} actions on the right gender.\n` +
    `Score 0-2 (hard reject) ONLY for: collage/grid layouts, multi-clip compilations, or no person visible.\n` +
    `Mirrors, second people, occlusion and busy backgrounds are all fine — nothing is reused but the ideas.\n` +
    `Deduct for wrong gender. Judge format from the thumbnail; titles routinely lie.\n`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/evaluator.test.ts`
Expected: PASS.

Then fix the caller in `src/lib/pipeline.ts` (buildRemakeSteps `findCandidates`): change
`const scored = await d.rank(product, raw, {}, { mode: 'remake' });`
to
`const scored = await d.rank(product, raw);`

Run: `npx vitest run src/lib/pipeline.test.ts` — Expected: PASS (or, if a pipeline test asserted the `mode` arg, update it to the 2-arg call).

- [ ] **Step 5: Commit**

```bash
git add src/lib/evaluator.ts src/lib/evaluator.test.ts src/lib/pipeline.ts
git commit -m "feat: single industry-match candidate rubric, drop swap-only filters"
```

---

### Task 2: Enrich the video brief with lighting/color/texture + beats timeline

**Files:**
- Modify: `src/lib/describe.ts`
- Modify: `src/lib/describe.test.ts`

**Interfaces:**
- Consumes: `extractFrames` (`./qc`), `Anthropic`.
- Produces: `VideoBrief` gains `lighting: { direction: string; quality: string }`, `colorGrade: string`, `skinTexture: string`, and `beats: Array<{ t: string; action: string }>` REPLACING `subjectMotion: string[]`. `describeReferenceVideo` samples 14 frames. `buildGenerationPrompt(brief)` emits the enriched, realism-tuned prompt.

- [ ] **Step 1: Write the failing test**

In `src/lib/describe.test.ts`, update the valid-brief JSON the fake client returns to include the new fields, and add assertions:

```ts
const VALID = JSON.stringify({
  summary: 'A woman applies lipstick to camera.',
  subject: { description: 'woman, 20s', outfitStyle: 'casual' },
  beats: [{ t: '0s', action: 'uncaps lipstick' }, { t: '2s', action: 'applies to lips' }],
  scene: { setting: 'bathroom', timeOfDay: 'day', overlays: 'N/A', dynamics: 'static' },
  spatialFraming: { shotSize: 'close-up', subjectPosition: 'centered', depth: 'shallow' },
  camera: { movement: 'static', angle: 'eye-level', steadiness: 'handheld', speed: 'slow' },
  lighting: { direction: 'front-left key', quality: 'soft diffused' },
  colorGrade: 'warm, lifted blacks',
  skinTexture: 'natural pores, minimal retouch',
  pacing: 'calm',
  whatMakesItWork: ['relatable', 'clear product', 'clean light'],
  differentiationSeeds: ['plain studio backdrop', 'add a smile beat', 'morning light'],
});

it('parses the enriched brief including lighting, colorGrade, skinTexture, beats', async () => {
  const brief = await describeReferenceVideo('/tmp/x.mp4', {
    extract: async () => ['/tmp/f1.jpg'],
    client: fakeClient(VALID),
    readImage: () => 'AAAA',
  });
  expect(brief.lighting.direction).toContain('front-left');
  expect(brief.colorGrade).toBe('warm, lifted blacks');
  expect(brief.skinTexture).toContain('pores');
  expect(brief.beats.map((b) => b.action)).toContain('applies to lips');
});

it('throws when a new required field is missing', async () => {
  const bad = JSON.parse(VALID); delete bad.lighting;
  await expect(
    describeReferenceVideo('/tmp/x.mp4', { extract: async () => ['/tmp/f1.jpg'], client: fakeClient(JSON.stringify(bad)), readImage: () => 'A' })
  ).rejects.toThrow(/missing/);
});

it('buildGenerationPrompt includes beats, lighting and a realism cue', () => {
  const brief = JSON.parse(VALID) as VideoBrief;
  const p = buildGenerationPrompt(brief);
  expect(p).toContain('applies to lips');
  expect(p).toContain('soft diffused');
  expect(p.toLowerCase()).toMatch(/film grain|pores|natural skin/);
});
```

Add `fakeClient` helper if absent:

```ts
function fakeClient(text: string) {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } } as unknown as Anthropic;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/describe.test.ts`
Expected: FAIL (`lighting` undefined; `beats` not on type; prompt missing realism cue).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/describe.ts`:

Update the type:

```ts
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
  differentiationSeeds: string[];
};

const REQUIRED_KEYS: Array<keyof VideoBrief> = [
  'summary', 'subject', 'beats', 'scene', 'spatialFraming', 'camera',
  'lighting', 'colorGrade', 'skinTexture', 'pacing', 'whatMakesItWork', 'differentiationSeeds',
];
```

Update `DESCRIBE_PROMPT` JSON template to match (swap `subjectMotion` for `beats`, add the three fields):

```ts
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
```

Change frame count in `describeReferenceVideo`: `const frames = await extract(videoPath, 14);`

Rewrite `buildGenerationPrompt`:

```ts
export function buildGenerationPrompt(brief: VideoBrief): string {
  return [
    `The person in the reference image, wearing exactly the outfit shown in it.`,
    `Motion, in order: ${brief.beats.map((b) => `${b.t} ${b.action}`).join('; ')}.`,
    `Setting: ${brief.differentiationSeeds[0]}.`,
    `Framing: ${brief.spatialFraming.shotSize}, subject ${brief.spatialFraming.subjectPosition}, ${brief.spatialFraming.depth}.`,
    `Camera: ${brief.camera.movement}, ${brief.camera.angle}, ${brief.camera.steadiness}, ${brief.camera.speed}.`,
    `Lighting: ${brief.lighting.direction}, ${brief.lighting.quality}. Color grade: ${brief.colorGrade}.`,
    `Pacing: ${brief.pacing}.`,
    `Photorealistic vertical UGC video. Natural human skin with visible pores (${brief.skinTexture}), soft directional light, subtle film grain, slight handheld micro-shake, no plastic/AI sheen, no on-screen text or graphics.`,
  ].join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/describe.test.ts`
Expected: PASS.

Run: `npx vitest run src/lib/pipeline.test.ts` — Expected: PASS (buildRemakeSteps writes `brief.json`; if a pipeline test builds a fixture brief, update it to the enriched shape).

- [ ] **Step 5: Commit**

```bash
git add src/lib/describe.ts src/lib/describe.test.ts
git commit -m "feat: enrich video brief with lighting/color/texture + beats timeline"
```

---

### Task 3: Add PhotoBrief + describeReferencePhoto + buildPhotoPrompt

**Files:**
- Modify: `src/lib/describe.ts`
- Modify: `src/lib/describe.test.ts`

**Interfaces:**
- Produces:
  - `type PhotoBrief = { summary: string; subject: { description: string; outfitStyle: string }; scene: { setting: string; timeOfDay: string; overlays: string }; spatialFraming: { shotSize: string; subjectPosition: string; depth: string }; lighting: { direction: string; quality: string }; colorGrade: string; skinTexture: string; whatMakesItWork: string[]; differentiationSeeds: string[] }`
  - `describeReferencePhoto(photoPath: string, deps?: { client?: Anthropic; readImage?: (p: string) => string }) => Promise<PhotoBrief>`
  - `buildPhotoPrompt(brief: PhotoBrief) => string`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/describe.test.ts`:

```ts
const VALID_PHOTO = JSON.stringify({
  summary: 'A woman holds a lipstick beside her face.',
  subject: { description: 'woman, 20s', outfitStyle: 'casual' },
  scene: { setting: 'bedroom', timeOfDay: 'day', overlays: 'N/A' },
  spatialFraming: { shotSize: 'medium close-up', subjectPosition: 'centered', depth: 'shallow' },
  lighting: { direction: 'window left', quality: 'soft' },
  colorGrade: 'warm pastel',
  skinTexture: 'natural, light freckles',
  whatMakesItWork: ['clean', 'product visible', 'flattering light'],
  differentiationSeeds: ['plain studio backdrop', 'brighter key', 'add a smile'],
});

it('describeReferencePhoto parses a single-frame brief', async () => {
  const brief = await describeReferencePhoto('/tmp/p.jpg', { client: fakeClient(VALID_PHOTO), readImage: () => 'A' });
  expect(brief.lighting.quality).toBe('soft');
  expect(brief.colorGrade).toBe('warm pastel');
});

it('describeReferencePhoto throws on missing field', async () => {
  const bad = JSON.parse(VALID_PHOTO); delete bad.colorGrade;
  await expect(describeReferencePhoto('/tmp/p.jpg', { client: fakeClient(JSON.stringify(bad)), readImage: () => 'A' }))
    .rejects.toThrow(/missing/);
});

it('buildPhotoPrompt includes setting, lighting and realism cue', () => {
  const p = buildPhotoPrompt(JSON.parse(VALID_PHOTO) as PhotoBrief);
  expect(p).toContain('plain studio backdrop');
  expect(p).toContain('soft');
  expect(p.toLowerCase()).toMatch(/film grain|pores|natural skin/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/describe.test.ts`
Expected: FAIL (`describeReferencePhoto`/`buildPhotoPrompt`/`PhotoBrief` not exported).

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/describe.ts`:

```ts
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

/** Watches a single downloaded reference photo and returns its structured brief. */
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
  const res = await client.messages.create({ model: 'claude-opus-4-8', max_tokens: 1024, messages: [{ role: 'user', content: blocks }] });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/describe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/describe.ts src/lib/describe.test.ts
git commit -m "feat: add PhotoBrief, describeReferencePhoto, buildPhotoPrompt"
```

---

### Task 4: Add generatePhotoFromImage (image-to-image via nano-banana)

**Files:**
- Modify: `src/lib/generate.ts`
- Modify: `src/lib/generate.test.ts`

**Interfaces:**
- Consumes: `runKieTask` (`./kie`).
- Produces: `generatePhotoFromImage(input: { imageUrl: string; prompt: string; aspectRatio?: string }, deps?: { run?: typeof runKieTask }) => Promise<string>` — returns a hosted URL of the generated photo.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/generate.test.ts`:

```ts
it('generatePhotoFromImage calls nano-banana edit with the avatar image and prompt', async () => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const run = (async (model, input) => { calls.push({ model, input }); return 'http://out/photo.jpg'; }) as typeof runKieTask;
  const url = await generatePhotoFromImage({ imageUrl: 'http://a/avatar.jpg', prompt: 'a woman in a studio', aspectRatio: '3:4' }, { run });
  expect(url).toBe('http://out/photo.jpg');
  expect(calls[0].model).toContain('nano-banana');
  expect(calls[0].input.image_urls).toEqual(['http://a/avatar.jpg']);
  expect(calls[0].input.prompt).toBe('a woman in a studio');
  expect(calls[0].input.aspect_ratio).toBe('3:4');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/generate.test.ts`
Expected: FAIL (`generatePhotoFromImage` not exported).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/generate.ts`, update the header comment first line to `Media generation — the "shoot" half of remake mode ...`, then append:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/generate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generate.ts src/lib/generate.test.ts
git commit -m "feat: add generatePhotoFromImage image-to-image generator"
```

---

### Task 5: Add buildPictureRemakeSteps to the pipeline

**Files:**
- Modify: `src/lib/pipeline.ts`
- Modify: `src/lib/pipeline.test.ts`

**Interfaces:**
- Consumes: `findViralPhotos`, `describeReferencePhoto`, `buildPhotoPrompt`, `generatePhotoFromImage`, `distinctifyImage`, `dressAvatar`, `rankCandidates`, `checkImageQuality`, `checkAvatarIdentity`, `nearestAspectRatio`, `defaultUpload`, `downloadTo`, `dressAndVerify` (already in pipeline.ts).
- Produces: `buildPictureRemakeSteps(args) => PipelineSteps` — same `args` shape as `buildPictureSteps` (searchQueries, faceImagePath, productPhotoPath?, jobId, product?, chosenDurationS?, deps?). Generates rather than swaps.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/pipeline.test.ts` (follow the existing buildRemakeSteps test style — all deps mocked, no network):

```ts
describe('buildPictureRemakeSteps', () => {
  const baseDeps = {
    find: async () => [{ url: 'u', views: 2e6, downloadUrl: 'http://c/p.jpg' }] as Candidate[],
    rank: async (_p, c) => c.map((x) => ({ ...x, relevanceScore: 8, reason: 'ok' })),
    download: async (_url: string, dest: string) => dest,
    describePhoto: async () => ({
      summary: 's', subject: { description: 'w', outfitStyle: 'c' },
      scene: { setting: 'room', timeOfDay: 'day', overlays: 'N/A' },
      spatialFraming: { shotSize: 'mcu', subjectPosition: 'center', depth: 'shallow' },
      lighting: { direction: 'left', quality: 'soft' }, colorGrade: 'warm', skinTexture: 'natural',
      whatMakesItWork: ['a', 'b', 'c'], differentiationSeeds: ['studio', 'x', 'y'],
    }),
    generatePhoto: async () => 'http://out/gen.jpg',
    processImage: async (_i: string, o: string) => o,
    uploadForUrl: async () => 'http://up/img',
    checkImage: async () => ({ pass: true, reason: '' }),
    checkIdentity: async () => ({ pass: true, reason: '' }),
    dress: async () => 'http://up/dressed',
  };

  it('generates, QC-passes and processes a picture without any swap', async () => {
    const steps = buildPictureRemakeSteps({ searchQueries: ['makeup'], faceImagePath: 'media/jobs/1/face.jpg', jobId: 1, deps: baseDeps as never });
    const src = await steps.prepareSource({ url: 'u', views: 2e6, downloadUrl: 'http://c/p.jpg' } as Candidate);
    expect(src).toContain('source.jpg');
    const out = await steps.swap(src);
    expect(out).toContain('gen.jpg');
    const fin = await steps.process(out as string);
    expect(fin).toContain('final.jpg');
  });

  it('rerolls once on QC failure then fails to approval', async () => {
    let n = 0;
    const steps = buildPictureRemakeSteps({
      searchQueries: ['makeup'], faceImagePath: 'media/jobs/1/face.jpg', jobId: 1,
      deps: { ...baseDeps, checkImage: async () => { n++; return { pass: false, reason: 'extra hand' }; } } as never,
    });
    await expect(steps.swap('media/jobs/1/source.jpg')).rejects.toThrow(/quality check failed/);
    expect(n).toBe(2); // one initial + one reroll
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: FAIL (`buildPictureRemakeSteps` not exported).

- [ ] **Step 3: Write minimal implementation**

Add imports at the top of `src/lib/pipeline.ts`:

```ts
import { describeReferencePhoto, buildPhotoPrompt } from './describe';
import { generatePhotoFromImage } from './generate';
```
(Merge with the existing `./describe` import line; `describeReferenceVideo, buildGenerationPrompt` are already imported.)

Add the interface + builder (near `buildRemakeSteps`):

```ts
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
    async swap(sourcePath: string) {
      const brief = await d.describePhoto(sourcePath);
      try { fs.writeFileSync(`${dir}/brief.json`, JSON.stringify(brief, null, 1)); } catch { /* diagnostic only */ }
      const prompt = buildPhotoPrompt(brief);
      let imageUrl = await d.uploadForUrl(args.faceImagePath);
      if (args.productPhotoPath) {
        const productUrl = await d.uploadForUrl(args.productPhotoPath);
        imageUrl = await dressAndVerify(
          { avatarUrl: imageUrl, productUrl, faceImagePath: args.faceImagePath, dressedPath: `${dir}/dressed.jpg` },
          { dress: d.dress, download: d.download, checkIdentity: d.checkIdentity }
        );
      }
      const aspectRatio = await nearestAspectRatio(sourcePath);
      let lastReason = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const resultUrl = await d.generatePhoto({ imageUrl, prompt, aspectRatio });
        const genPath = await d.download(resultUrl, `${dir}/swapped.jpg`);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline.ts src/lib/pipeline.test.ts
git commit -m "feat: add buildPictureRemakeSteps generation pipeline"
```

---

### Task 6: Rewire routes to the two generation modes

**Files:**
- Modify: `src/app/api/jobs/[id]/advance/route.ts`
- Modify: `src/lib/jobs.ts` (`MediaType`)
- Modify: `src/app/api/jobs/route.ts` (request body type)
- Modify: `src/app/api/jobs/route.test.ts` if it asserts a removed mediaType

**Interfaces:**
- Produces: `MediaType = 'video' | 'picture'`. Advance route selects `buildPictureRemakeSteps` for `picture`, else `buildRemakeSteps`.

- [ ] **Step 1: Write the failing test**

In `src/app/api/jobs/route.test.ts`, add (or adjust) a case asserting a `picture` job is created and stored with `media_type='picture'`, and that omitting `mediaType` defaults to `video`. Use the file's existing in-memory DB harness. Example assertion to add:

```ts
it('creates a picture-mode job', async () => {
  const res = await POST(makeReq({ productId, faceImageBase64: 'AAAA', mediaType: 'picture' }));
  const { jobIds } = await res.json();
  const row = db.prepare('SELECT media_type FROM jobs WHERE id = ?').get(jobIds[0]) as { media_type: string };
  expect(row.media_type).toBe('picture');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: FAIL only if the harness needs the case; if it already passes, proceed (the type change is the real deliverable).

- [ ] **Step 3: Write minimal implementation**

`src/lib/jobs.ts`: change
`export type MediaType = 'video' | 'picture' | 'remake';`
to
`export type MediaType = 'video' | 'picture';`

`src/app/api/jobs/route.ts`: change the destructured body type `mediaType?: 'video' | 'picture' | 'remake';` to `mediaType?: 'video' | 'picture';`

`src/app/api/jobs/[id]/advance/route.ts`: replace the imports and build selector:

```ts
import { buildRemakeSteps, buildPictureRemakeSteps } from '@/lib/pipeline';
```
```ts
const build = job.media_type === 'picture' ? buildPictureRemakeSteps : buildRemakeSteps;
```

(Remove the `buildSteps, buildPictureSteps` import and the three-way ternary.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/jobs/route.test.ts src/app/api/jobs/[id]/advance/route.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit` — Expected: errors ONLY from now-unused `buildSteps`/`buildPictureSteps` if referenced elsewhere; those are deleted in Task 7. If tsc blocks, proceed to Task 7 in the same working session before committing. Otherwise commit now.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs.ts src/app/api/jobs/route.ts "src/app/api/jobs/[id]/advance/route.ts" src/app/api/jobs/route.test.ts
git commit -m "feat: route video->remake, picture->picture-remake; drop remake media type"
```

---

### Task 7: Delete the swap paths

**Files:**
- Delete: `src/lib/swap/` (whole dir: `fal.ts`, `fal.test.ts`, `replicate.ts`, `kie.ts`, `types.ts`, `index.ts`, `index.test.ts`)
- Delete: `src/lib/imageswap.ts`, `src/lib/imageswap.test.ts`
- Modify: `src/lib/pipeline.ts` (remove `buildSteps`, `buildPictureSteps`, `PipelineDeps`, `PicturePipelineDeps`, and now-unused imports: `swapPersonInPhoto`, `getSwapProvider`, `findViralVideos` only if unused, `checkSourceSuitability`, `checkVideoQuality` if unused)
- Modify: `src/lib/qc.ts` (remove `checkSourceSuitability` + `SOURCE_PROMPT`), `src/lib/qc.test.ts` (remove its tests)
- Modify: `src/lib/integration.live.test.ts` (remove the `getSwapProvider().swap()` smoke test)

**Interfaces:**
- Consumes: nothing new.
- Produces: pipeline exports shrink to `buildRemakeSteps`, `buildPictureRemakeSteps`, `nearestAspectRatio`.

- [ ] **Step 1: Delete files and prune references**

```bash
git rm -r src/lib/swap
git rm src/lib/imageswap.ts src/lib/imageswap.test.ts
```

In `src/lib/pipeline.ts`: delete `buildSteps`, `buildPictureSteps`, `PipelineDeps`, `PicturePipelineDeps`. Remove imports that are now unused: `swapPersonInPhoto`, `getSwapProvider`, `distinctify` (if only buildSteps used it — check: buildRemakeSteps uses `distinctify`, keep it), `checkSourceSuitability`, `checkVideoQuality` (buildRemakeSteps uses it, keep). Keep: `findViralVideos` (buildRemakeSteps), `findViralPhotos`, `resolveVideoUrl`, `downloadTo`, `distinctify`, `distinctifyImage`, `resolveFace`, `dressAvatar`, `rankCandidates`, `checkVideoQuality`, `checkImageQuality`, `checkAvatarIdentity`, `kieUpload`, `describeReference*`, `buildGenerationPrompt`, `buildPhotoPrompt`, `generateVideoFromImage`, `generatePhotoFromImage`, `ffmpeg`.

In `src/lib/qc.ts`: delete `SOURCE_PROMPT` and `checkSourceSuitability`. In `src/lib/qc.test.ts`: delete tests referencing them.

In `src/lib/integration.live.test.ts`: delete the third `it(...)` (the `getSwapProvider().swap()` test) and the now-unused `getSwapProvider` import and `SAMPLE_VIDEO_URL`/`uploadForUrl`/`fetchToTmp` helpers if only that test used them.

- [ ] **Step 2: Run the full suite to find dangling references**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: initially FAIL with "cannot find module './swap'" / "checkSourceSuitability is not exported" style errors pointing at each dangling reference.

- [ ] **Step 3: Fix each dangling reference**

Follow the tsc/vitest errors until both are clean. Every fix is a deletion of a swap-era import or test, not new logic.

- [ ] **Step 4: Run the full suite to verify green**

Run: `npx vitest run`
Expected: PASS (swap tests gone, everything else green).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete video-swap and photo-swap paths"
```

---

### Task 8: Rename status swapping -> generating and step swap -> generate

**Files:**
- Modify: `src/lib/jobs.ts` (`JobStatus`, `AUTO_ADVANCE_STATUSES`, `PipelineSteps.swap`->`generate`, `advanceJob` transitions + `qualityFail` check)
- Modify: `src/lib/pipeline.ts` (rename the `swap` method to `generate` in both surviving builders)
- Modify: `src/lib/jobs.test.ts` and `src/lib/pipeline.test.ts` (rename `.swap(` calls / status strings)

**Interfaces:**
- Produces: `JobStatus` uses `'generating'` in place of `'swapping'`; `PipelineSteps.generate(sourcePath)` replaces `.swap(sourcePath)`.

- [ ] **Step 1: Update the tests first (they define the new names)**

In `src/lib/jobs.test.ts`: replace every `'swapping'` string literal with `'generating'`, and every `steps.swap`/`swap:` in mocked `PipelineSteps` with `generate`. In `src/lib/pipeline.test.ts`: replace `.swap(` calls on the returned steps with `.generate(` and any `'swapping'` status with `'generating'`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/jobs.test.ts src/lib/pipeline.test.ts`
Expected: FAIL (`generate` not on `PipelineSteps`; status `generating` never set).

- [ ] **Step 3: Apply the rename in source**

`src/lib/jobs.ts`:
- `JobStatus`: replace `| 'swapping'` with `| 'generating'`.
- `AUTO_ADVANCE_STATUSES`: replace `'swapping'` with `'generating'`.
- `PipelineSteps`: rename `swap(sourcePath: string): Promise<string>;` to `generate(sourcePath: string): Promise<string>;`.
- In `advanceJob`:
  - `downloading` branch: `setJob(db, jobId, { status: 'generating', source_video_path: sourcePath }); return 'generating';`
  - Replace the whole `if (status === 'swapping')` block with `if (status === 'generating')` and call `await steps.generate(job.source_video_path)`.
  - `qualityFail`: `const qualityFail = status === 'generating' && message.includes('quality check failed');`

`src/lib/pipeline.ts`: in `buildRemakeSteps` and `buildPictureRemakeSteps`, rename the returned `async swap(sourcePath) {` to `async generate(sourcePath) {`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run` and `npx tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs.ts src/lib/pipeline.ts src/lib/jobs.test.ts src/lib/pipeline.test.ts
git commit -m "refactor: rename swapping status and swap step to generating/generate"
```

---

### Task 9: Simplify the UI to two generation modes

**Files:**
- Modify: `src/app/components/ProductUpload.tsx` (media-type selector: 3 -> 2 options)
- Modify: `src/app/components/JobQueue.tsx` (status label: `swapping`->`generating`; any `remake` label)
- Test: manual (UI); no unit test framework for these components beyond what exists.

**Interfaces:**
- Consumes: the two-mode `MediaType`.

- [ ] **Step 1: Locate the selector and labels**

Run: `git grep -n "remake\|swapping\|media_type\|mediaType" src/app/components`
Expected: the `<select>`/radio options in `ProductUpload.tsx` and a status->label map in `JobQueue.tsx`.

- [ ] **Step 2: Edit ProductUpload.tsx**

Reduce the media-type control to exactly two options — `video` (label e.g. "Video") and `picture` (label e.g. "Picture") — removing the `remake` option. If `video` was previously labeled "Face-swap video", relabel to just "Video". Ensure the default selected value is `video`.

- [ ] **Step 3: Edit JobQueue.tsx**

In the status-to-label mapping, rename the `swapping` entry to `generating` with a user-facing label like "Generating…". Remove any `remake`-specific labeling (all jobs are generation now).

- [ ] **Step 4: Verify build + boot**

Run: `npm run build`
Expected: compiles, all routes emit.
Run: `npm run dev`, open `http://localhost:3000`, confirm the upload form shows exactly Video/Picture and no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/ProductUpload.tsx src/app/components/JobQueue.tsx
git commit -m "feat: two-mode (video/picture) generation UI"
```

---

## Live smoke (manual, after all tasks — costs real credits)

Not a task; run when you want end-to-end proof:
1. `npm run dev`, upload a beauty product + avatar, mediaType `video`, approve a clip, drive to `ready` via `scripts/e2e-driver.mjs` (E2E_MEDIA is no longer needed — `video` is now remake).
2. Repeat with mediaType `picture`.
3. Eyeball realism (skin, lighting, no plastic sheen). If insufficient, revisit the deferred model-upgrade decision in the spec.

## Self-Review notes

- Spec §"Modules deleted" → Task 7. §"Modules added" (buildPictureRemakeSteps) → Task 5. §Filtering → Task 1. §Description → Tasks 2-3. §Realism prompts → Tasks 2-3. §Picture generation call → Task 4. §Status rename → Task 8. §UI → Task 9. All covered.
- `e2e-driver.mjs` `E2E_MEDIA` accepts `picture|remake`; after this plan `remake` is gone and `video`==remake. The driver still works for `video`/`picture`; updating its allow-list is optional cleanup (noted, not required for green tests).
- Type names consistent across tasks: `PhotoBrief`, `describeReferencePhoto`, `buildPhotoPrompt`, `generatePhotoFromImage`, `buildPictureRemakeSteps`, `PipelineSteps.generate`, status `'generating'`.
