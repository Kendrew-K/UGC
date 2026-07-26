# Remake Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third job mode, `remake`, that turns a client-chosen viral clip into a *brand-new* AI-generated video: describe the clip (5-aspect brief, already built in `src/lib/describe.ts`) → generate a fresh video from that brief + the dressed avatar via KIE image-to-video → existing artifact QC → postprocess.

**Architecture:** Remake reuses the entire existing job state machine (`queued → awaiting_approval → downloading → swapping → processing → ready`) — no new statuses, no schema migration (`media_type` is a plain TEXT column). Only the *meaning* of the `swapping` stage changes: instead of `swap(video, avatar)` it runs `describe(source) → buildGenerationPrompt → dress avatar → generateVideoFromImage → QC (with one cheap retry)`. The scraper, approval UI, artifact QC gate, and distinctify pass are reused untouched. The source-suitability gate is *skipped* in remake mode (mirrors/second people/collages don't matter when no pixels are reused).

**Tech Stack:** Next.js/TypeScript strict, vitest, better-sqlite3, KIE jobs API (`runKieTask` in `src/lib/kie.ts`), Claude vision (existing `describe.ts`), fluent-ffmpeg.

## Global Constraints

- **NO git commits.** Kendrew commits only when he explicitly says so. Every "commit" step in the normal skill template is replaced by "verify suite green". Do not run `git commit` or `git push`.
- TypeScript strict; all external API calls live in `src/lib/` modules; UI/API routes never call third-party APIs directly.
- Tests: vitest, `npx vitest run <file>` (never bare `vitest` — it watches). Full suite must stay green: `npx vitest run --exclude "**/*.live.test.ts"` (111 tests before this plan).
- All new module functions take a `deps` object for injection, defaulting to real implementations (established repo pattern — see `src/lib/qc.ts`, `src/lib/pipeline.ts`).
- Live tests gated behind `RUN_LIVE_TESTS=1`, write results to a JSON file (vitest v4 swallows console.log from passing tests), and are deleted after use.
- QC on *generated* video fails CLOSED into a retry (generation is cheap, ~$0.25–0.50/roll), then reverts the job to `awaiting_approval` via the existing `quality check failed` error-message convention in `src/lib/jobs.ts` (`advanceJob` catch block already handles this — do not touch it).
- Env loading for live runs (PowerShell): `Get-Content .env | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), 'Process') } }`

---

### Task 1: Pin down the KIE image-to-video model slug and input schema

No code. Output: three facts recorded at the top of Task 2's implementation as constants — (1) model slug, (2) input field names, (3) duration/aspect constraints.

**Files:** none (research only).

**Interfaces:**
- Produces: the literal string for `DEFAULT_I2V_MODEL` and the input-object shape used in Task 2.

- [ ] **Step 1: Read KIE's model docs for image-to-video options**

Run (WebFetch or curl) against these, in order, until slug + input schema for an i2v model is confirmed:
- `https://kie.ai/` (model catalog)
- `https://docs.kie.ai/` (API docs)
- `https://kie.ai/kling` / `https://kie.ai/seedance` / `https://kie.ai/wan` (model pages)

Candidates to look for, in preference order (cheap → premium):
1. Kling standard i2v (search for slug pattern like `kling/…` — KIE slugs seen live in this repo: `wan/2-2-animate-replace`, `google/nano-banana-edit`)
2. WAN 2.2 i2v (`wan/2-2-i2v` pattern)
3. Seedance i2v

Record: exact slug, whether the input takes `image_url` + `prompt`, how duration is expressed (`duration` seconds vs `"5"|"10"` enum), and aspect-ratio field name if any.

- [ ] **Step 2: Confirm the slug is accepted by the KIE jobs API without paying**

Submit a deliberately *invalid* request (missing required fields) and confirm the error is a field-validation error (slug exists) rather than "model not found":

```bash
KEY=$(grep -E '^KIE_API_KEY=' .env | cut -d= -f2- | tr -d '"' | tr -d '\r')
curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -X POST https://api.kie.ai/api/v1/jobs/createTask \
  -d '{"model":"<CANDIDATE_SLUG>","input":{}}'
```

Expected: HTTP 200 with a validation-error body naming missing input fields (slug valid), or an explicit unknown-model error (try next candidate). If a task is accidentally created, note the taskId — an empty-input task will fail server-side at no/negligible cost.

---

### Task 2: `generate.ts` — image-to-video call

**Files:**
- Create: `src/lib/generate.ts`
- Test: `src/lib/generate.test.ts`

**Interfaces:**
- Consumes: `runKieTask(model, input, opts?)` from `src/lib/kie.ts` (returns `Promise<string>` — first result URL).
- Produces: `generateVideoFromImage(input: GenerateInput, deps?: { run?: typeof runKieTask }): Promise<string>` where `GenerateInput = { imageUrl: string; prompt: string; durationS?: number }`. Returns hosted URL of the generated video. Model slug overridable via env `KIE_I2V_MODEL`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/generate.test.ts
import { describe, it, expect } from 'vitest';
import { generateVideoFromImage } from './generate';

describe('generateVideoFromImage', () => {
  it('submits the dressed avatar + prompt to the KIE i2v model and returns the video URL', async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const url = await generateVideoFromImage(
      { imageUrl: 'https://cdn/dressed.jpg', prompt: 'walks toward camera', durationS: 10 },
      { run: async (model, input) => { calls.push({ model, input }); return 'https://cdn/generated.mp4'; } }
    );
    expect(url).toBe('https://cdn/generated.mp4');
    expect(calls[0].model).toBeTruthy();
    expect(calls[0].input.image_url).toBe('https://cdn/dressed.jpg');
    expect(calls[0].input.prompt).toBe('walks toward camera');
  });

  it('honors the KIE_I2V_MODEL env override', async () => {
    process.env.KIE_I2V_MODEL = 'test/override-model';
    try {
      const calls: string[] = [];
      await generateVideoFromImage(
        { imageUrl: 'u', prompt: 'p' },
        { run: async (model) => { calls.push(model); return 'x'; } }
      );
      expect(calls[0]).toBe('test/override-model');
    } finally {
      delete process.env.KIE_I2V_MODEL;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/generate.test.ts`
Expected: FAIL — cannot resolve `./generate`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/generate.ts
/**
 * Video generation — the "shoot" half of remake mode: turns the dressed
 * avatar photo + a brief-derived prompt into a brand-new UGC clip via KIE's
 * image-to-video API. No source pixels are reused, so none of the swap
 * pipeline's source constraints (mirrors, second people, collages) apply.
 * Owns: the single i2v call.
 * Does NOT: build prompts (describe.ts), upload files, or run QC.
 */
import { runKieTask } from './kie';

// <SLUG FROM TASK 1> — verified live <date> via Task 1 probe.
const DEFAULT_I2V_MODEL = '<SLUG_FROM_TASK_1>';

export type GenerateInput = { imageUrl: string; prompt: string; durationS?: number };

/** Returns a hosted URL of the generated clip. */
export function generateVideoFromImage(
  input: GenerateInput,
  deps: { run?: typeof runKieTask } = {}
): Promise<string> {
  const run = deps.run ?? runKieTask;
  const model = process.env.KIE_I2V_MODEL || DEFAULT_I2V_MODEL;
  return run(model, {
    image_url: input.imageUrl,
    prompt: input.prompt,
    // Field name/format per Task 1 findings — adjust here if the model takes
    // an enum ("5"|"10") instead of seconds.
    duration: input.durationS ?? 10,
    aspect_ratio: '9:16',
  });
}
```

(Adjust `duration` / `aspect_ratio` field names to exactly what Task 1 found. If Task 1 found no aspect-ratio field, omit it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/generate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify suite green**

Run: `npx vitest run --exclude "**/*.live.test.ts"` and `npx tsc --noEmit`
Expected: all tests pass, no type errors.

---

### Task 3: Mode-aware candidate ranking (remake relaxes the swap rules)

**Files:**
- Modify: `src/lib/evaluator.ts` (function `rankCandidates`, header string, duration filter)
- Test: `src/lib/evaluator.test.ts` (append)

**Interfaces:**
- Consumes: existing `rankCandidates(product, candidates, deps)` — currently swap-rubric only, hard 20s cap.
- Produces: `rankCandidates(product, candidates, deps?, opts?: { mode?: 'swap' | 'remake' })`. Default `'swap'` = today's behavior exactly (existing callers unchanged). `'remake'` = no duration cap, relaxed rubric: hard-reject only collages/compilations, no-person, and wrong product; mirrors/second people/occlusion are fine (only frames are analyzed, no pixels reused).

- [ ] **Step 1: Write the failing tests** (append to `src/lib/evaluator.test.ts`)

```typescript
describe('rankCandidates remake mode', () => {
  it('does not apply the duration cap — the brief only needs frames, not a swappable clip', async () => {
    const client = fakeClient([{ index: 0, score: 8, reason: 'ok' }]);
    const out = await rankCandidates(product, [clip({ durationS: 45 })], { client }, { mode: 'remake' });
    expect(out).toHaveLength(1);
  });

  it('uses the relaxed rubric: mirrors and second people are acceptable, collages still rejected', async () => {
    const seen: Anthropic.ContentBlockParam[][] = [];
    const client = fakeClient([{ index: 0, score: 8, reason: 'ok' }], seen);
    await rankCandidates(product, [clip({ durationS: 10 })], { client }, { mode: 'remake' });
    const promptText = seen[0].filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    expect(promptText).toMatch(/mirror.*(fine|acceptable|ok)/i);
    expect(promptText).toMatch(/collage/i);
    expect(promptText).not.toMatch(/hard reject.*mirror/i);
  });

  it('defaults to swap mode so existing callers keep the strict rubric', async () => {
    const client = fakeClient([{ index: 0, score: 9, reason: 'good' }]);
    const out = await rankCandidates(product, [clip({ durationS: 45 })], { client });
    expect(out).toEqual([]); // 45s clip still dropped by the swap cap
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/evaluator.test.ts`
Expected: first two new tests FAIL (opts parameter ignored / rubric mentions hard-reject mirrors); third passes (guards existing behavior).

- [ ] **Step 3: Implement**

In `src/lib/evaluator.ts`, change the signature and split the rubric:

```typescript
export async function rankCandidates(
  product: Classification,
  candidates: Candidate[],
  deps: { client?: Anthropic } = {},
  opts: { mode?: 'swap' | 'remake' } = {}
): Promise<ScoredCandidate[]> {
  const mode = opts.mode ?? 'swap';
  // Long clips only hurt the swap path (frame-step budget, temporal drift);
  // a remake brief just samples frames, so any length works.
  if (mode === 'swap') {
    candidates = candidates.filter((c) => c.durationS == null || c.durationS <= MAX_CLIP_SECONDS);
  }
  if (candidates.length === 0) return [];

  const client = deps.client ?? new Anthropic();

  const commonHeader =
    `Product: ${product.type} | gender: ${product.gender} | style: ${product.contentStyle} | industry: ${product.industry}\n\n`;
  const swapRubric = /* the existing header text, verbatim, unchanged */;
  const remakeRubric =
    `Rate each TikTok/Reels clip as CREATIVE REFERENCE for re-shooting a similar product video with a different person. Score 0–10.\n` +
    `10 = clearly showcases exactly this product type on the right gender with appealing, imitable actions.\n` +
    `Score 0-2 (hard reject) only for: collage/grid layouts, multi-outfit compilations, no person visible, or wrong product type.\n` +
    `Mirrors, second people, occlusion and busy backgrounds are all acceptable — nothing is reused from the clip except its ideas.\n` +
    `Judge format from the thumbnail; titles routinely lie.\n`;
  const header = commonHeader + (mode === 'remake' ? remakeRubric : swapRubric);
  // ... rest of the function unchanged
```

(Keep the existing swap rubric string identical — move it into `swapRubric`, don't rewrite it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/evaluator.test.ts`
Expected: PASS (all, including the 4 pre-existing tests).

- [ ] **Step 5: Verify suite green**

Run: `npx vitest run --exclude "**/*.live.test.ts"`
Expected: all pass.

---

### Task 4: `buildRemakeSteps` in the pipeline

**Files:**
- Modify: `src/lib/pipeline.ts`
- Test: `src/lib/pipeline.test.ts` (append)

**Interfaces:**
- Consumes: `describeReferenceVideo(videoPath, deps?)` and `buildGenerationPrompt(brief)` from `src/lib/describe.ts`; `generateVideoFromImage(input, deps?)` from Task 2; `checkVideoQuality(videoPath, deps?)` from `src/lib/qc.ts`; existing `dressAvatar`, `rankCandidates`, `downloadTo`, `defaultUpload`, `resolveVideoUrl`, `distinctify`.
- Produces: `buildRemakeSteps(args)` with the same `args` shape as `buildSteps` (`searchQueries, faceImagePath, productPhotoPath?, jobId, product?, chosenDurationS?, deps?`), returning `PipelineSteps`. New deps interface:

```typescript
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
}
```

Step semantics: `findCandidates` ranks with `{ mode: 'remake' }`; `prepareSource` downloads WITHOUT the source-suitability gate; `swap(sourcePath)` = describe → save `media/jobs/<id>/brief.json` (best-effort diagnostic) → dress avatar (mandatory product photo path may be null — dress only when present, same as buildSteps) → generate → download to `swapped.mp4` → `checkVideo` → on QC fail regenerate ONCE (generation is cheap) → still failing → `throw new Error('quality check failed: …')` (drives the existing revert-to-approval path in jobs.ts).

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('buildSteps', …)` block or a new block in `src/lib/pipeline.test.ts`)

```typescript
import { buildRemakeSteps } from './pipeline'; // add to existing import line

describe('buildRemakeSteps', () => {
  const brief = {
    summary: 's',
    subject: { description: 'someone', outfitStyle: 'jacket' },
    subjectMotion: ['walks toward camera'],
    scene: { setting: 'street', timeOfDay: 'day', overlays: 'N/A', dynamics: 'N/A' },
    spatialFraming: { shotSize: 'full body', subjectPosition: 'center', depth: 'shallow' },
    camera: { movement: 'static', angle: 'eye level', steadiness: 'steady', speed: 'real-time' },
    pacing: 'steady',
    whatMakesItWork: ['x'],
    differentiationSeeds: ['plain studio backdrop'],
  };

  function makeSteps(overrides: Record<string, unknown> = {}) {
    const calls = { generate: [] as Array<{ imageUrl: string; prompt: string }>, qc: 0 };
    const steps = buildRemakeSteps({
      searchQueries: ['q'], faceImagePath: 'media/face.jpg', productPhotoPath: 'media/products/7.jpg',
      jobId: 30, product: mockProduct,
      deps: {
        find: async () => [clip],
        rank: async (_p, cs) => cs.map((c) => ({ ...c, relevanceScore: 9, reason: 'r' })),
        download: async (_u: string, dest: string) => dest,
        resolveVideo: async () => 'http://v/clip.mp4',
        describe: async () => brief,
        generate: async (input: { imageUrl: string; prompt: string }) => { calls.generate.push(input); return 'http://cdn/generated.mp4'; },
        process: async (_i: string, o: string) => o,
        uploadForUrl: async (p: string) => `http://local/${p}`,
        dress: async ({ avatarUrl }: { avatarUrl: string }) => `http://dressed/${avatarUrl}`,
        checkVideo: async () => { calls.qc++; return { pass: true, reason: 'clean' }; },
        ...overrides,
      },
    });
    return { steps, calls };
  }

  it('generates from the dressed avatar with the brief-derived prompt', async () => {
    const { steps, calls } = makeSteps();
    const swapped = await steps.swap('media/jobs/30/source.mp4');
    expect(swapped).toBe('media/jobs/30/swapped.mp4');
    expect(calls.generate[0].imageUrl).toBe('http://dressed/http://local/media/face.jpg');
    expect(calls.generate[0].prompt).toContain('walks toward camera');
    expect(calls.generate[0].prompt).toContain('plain studio backdrop');
  });

  it('regenerates once when QC rejects, and returns the clean retry', async () => {
    const verdicts = [{ pass: false, reason: 'melted' }, { pass: true, reason: 'clean' }];
    const { steps, calls } = makeSteps({ checkVideo: async () => verdicts.shift()! });
    await expect(steps.swap('media/jobs/30/source.mp4')).resolves.toBe('media/jobs/30/swapped.mp4');
    expect(calls.generate).toHaveLength(2);
  });

  it('throws when the retry also fails QC, using the revert-to-approval error convention', async () => {
    const { steps } = makeSteps({ checkVideo: async () => ({ pass: false, reason: 'melted' }) });
    await expect(steps.swap('media/jobs/30/source.mp4')).rejects.toThrow(/quality check failed.*melted/);
  });

  it('prepareSource downloads without the source-suitability gate', async () => {
    const { steps } = makeSteps(); // note: no checkSource dep exists on remake deps at all
    await expect(steps.prepareSource(clip)).resolves.toBe('media/jobs/30/source.mp4');
  });

  it('ranks candidates in remake mode', async () => {
    let seenMode = '';
    const { steps } = makeSteps({
      rank: async (_p: unknown, cs: Candidate[], _d: unknown, opts?: { mode?: string }) => {
        seenMode = opts?.mode ?? 'unset';
        return cs.map((c) => ({ ...c, relevanceScore: 9, reason: 'r' }));
      },
    });
    await steps.findCandidates();
    expect(seenMode).toBe('remake');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: FAIL — `buildRemakeSteps` not exported.

- [ ] **Step 3: Implement `buildRemakeSteps`** (append to `src/lib/pipeline.ts`)

```typescript
import { describeReferenceVideo, buildGenerationPrompt } from './describe';
import { generateVideoFromImage } from './generate';

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
      const scored = await d.rank(product, raw, {}, { mode: 'remake' });
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

    async swap(sourcePath: string) {
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
        imageUrl = await d.dress({ avatarUrl: imageUrl, productUrl });
        try {
          await d.download(imageUrl, `${dir}/dressed.jpg`);
        } catch {
          // diagnostic artifact only
        }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: PASS (all, including 13 pre-existing).

- [ ] **Step 5: Verify suite green**

Run: `npx vitest run --exclude "**/*.live.test.ts"` and `npx tsc --noEmit`
Expected: all pass, no type errors.

---

### Task 5: Wire `remake` through jobs, API routes, and UI

**Files:**
- Modify: `src/lib/jobs.ts:29` (`MediaType` union)
- Modify: `src/app/api/jobs/route.ts:33` (request type)
- Modify: `src/app/api/jobs/[id]/advance/route.ts:48` (builder pick)
- Modify: `src/app/components/ProductUpload.tsx:42,339,351` (mode toggle + button label)
- Test: `src/app/api/jobs/route.test.ts` (append), `src/lib/pipeline.test.ts` (no change)

**Interfaces:**
- Consumes: `buildRemakeSteps` from Task 4.
- Produces: `MediaType = 'video' | 'picture' | 'remake'`; POST `/api/jobs` accepts `mediaType: 'remake'`; advance route builds remake steps when `job.media_type === 'remake'`.

- [ ] **Step 1: Write the failing test** (append to `src/app/api/jobs/route.test.ts`, following that file's existing POST-test pattern — reuse its db/mocking setup verbatim)

```typescript
it('creates a remake-mode job', async () => {
  // copy the file's existing "creates a job" test setup, changing only:
  //   body: { productId, faceImageBase64: FACE_B64, mediaType: 'remake' }
  // then assert:
  const row = db.prepare('SELECT media_type FROM jobs WHERE id = ?').get(jobIds[0]) as { media_type: string };
  expect(row.media_type).toBe('remake');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: FAIL — TypeScript rejects `'remake'` (union is `'video' | 'picture'`), or media_type stored as 'video' default.

- [ ] **Step 3: Implement the wiring (4 edits)**

`src/lib/jobs.ts`:
```typescript
export type MediaType = 'video' | 'picture' | 'remake';
```

`src/app/api/jobs/route.ts` (request type only):
```typescript
mediaType?: 'video' | 'picture' | 'remake';
```

`src/app/api/jobs/[id]/advance/route.ts`:
```typescript
import { buildSteps, buildPictureSteps, buildRemakeSteps } from '@/lib/pipeline';
// …
const build =
  job.media_type === 'picture' ? buildPictureSteps :
  job.media_type === 'remake' ? buildRemakeSteps :
  buildSteps;
```

`src/app/components/ProductUpload.tsx`:
```tsx
const [mediaType, setMediaType] = useState<'video' | 'picture' | 'remake'>('video');
// …
{(['video', 'picture', 'remake'] as const).map((t) => (
// …
{mediaType === 'video' ? 'Generate video' : mediaType === 'picture' ? 'Generate picture' : 'Generate remake'}
```

(Check the toggle's rendered label at line ~339 — if it prints `t` raw, `remake` shows as-is, which is fine.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify suite + typecheck green**

Run: `npx vitest run --exclude "**/*.live.test.ts"` and `npx tsc --noEmit`
Expected: all pass, no type errors.

---

### Task 6: Live end-to-end remake run

**Files:** none permanent. Uses `scripts/e2e-driver.mjs` (`E2E_MEDIA` currently supports `picture`; extend it) and the running detached dev server on `localhost:3000`.

**Interfaces:** consumes everything above; produces a verified `media/jobs/<id>/final.mp4`.

- [ ] **Step 1: Extend the e2e driver's media flag**

In `scripts/e2e-driver.mjs` line ~20 replace:
```javascript
const MEDIA_TYPE = process.env.E2E_MEDIA === 'picture' ? 'picture' : 'video';
```
with:
```javascript
const MEDIA_TYPE = ['picture', 'remake'].includes(process.env.E2E_MEDIA) ? process.env.E2E_MEDIA : 'video';
```

- [ ] **Step 2: Confirm the dev server is running (detached)**

```powershell
try { (Invoke-WebRequest -Uri http://localhost:3000/api/jobs -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 'DOWN' }
```
If DOWN: `Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev > dev-server.log 2>&1" -WorkingDirectory (Get-Location) -WindowStyle Hidden` then re-check. (Plain `run_in_background` npm tasks have been externally killed twice in this repo — always detach.)

- [ ] **Step 3: Run the driver to the candidate list**

```powershell
$env:E2E_MEDIA='remake'; node scripts/e2e-driver.mjs
```
Expected: creates product + job, reaches `awaiting_approval`, prints candidates with covers, exits PAUSED. Inspect covers (Read the cover URLs as images). Remake mode tolerates mirrors/second people — pick the highest-scoring clip that clearly shows the product.

- [ ] **Step 4: Approve and drive to ready**

```powershell
$env:E2E_MEDIA='remake'; $env:E2E_JOB='<jobId>'; $env:E2E_PICK='<index>'; node scripts/e2e-driver.mjs
```
Watch stages: `downloading` (no source gate) → `swapping` (describe ~30s + generate, minutes not tens of minutes) → `processing` → `ready`. If QC reverts to `awaiting_approval`, read `error`, decide: pick another clip or investigate the prompt.

- [ ] **Step 5: Verify the final video with real eyes**

```powershell
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,bit_rate -of default=noprint_wrappers=1 media/jobs/<id>/final.mp4
ffmpeg -y -v error -ss 1 -i media/jobs/<id>/final.mp4 -frames:v 1 <scratchpad>/r_a.jpg
ffmpeg -y -v error -ss 5 -i media/jobs/<id>/final.mp4 -frames:v 1 <scratchpad>/r_b.jpg
ffmpeg -y -v error -sseof -0.3 -i media/jobs/<id>/final.mp4 -frames:v 1 <scratchpad>/r_c.jpg
```
Read the frames. Acceptance: avatar identity matches `dressed.jpg`, product visible, no extra limbs, no melted background, no morphing items, coherent motion. Also read `media/jobs/<id>/brief.json` and confirm the video actually follows it (setting = differentiation seed, motion beats present).

- [ ] **Step 6: Report results to Kendrew with frames + cost**

Include: final verdict, generation cost (KIE credits consumed, visible in the recordInfo payload `creditsConsumed`), QC retries used, and any prompt wrinkles (e.g. the known depth-vs-studio contradiction in `buildGenerationPrompt`).

---

## Self-Review

- **Spec coverage:** describe stage (built previously) ✔; generate call (Task 2) ✔; relaxed clip rules per Kendrew's "any video they like" (Task 3) ✔; changed setting via differentiation seed (describe.ts, exercised in Task 4 prompt test) ✔; avatar + product via dress-first ordering (Task 4) ✔; option-not-new-project (Task 5 wires into existing app) ✔; immediate live test (Task 6) ✔.
- **Placeholder scan:** one deliberate unknown — the i2v model slug — is isolated in Task 1 with exact probe commands and lands as a constant in Task 2. No other TBDs.
- **Type consistency:** `rankCandidates` 4th param `opts { mode }` matches between Tasks 3 and 4; `generateVideoFromImage(input, deps)` matches between Tasks 2 and 4; `buildRemakeSteps` arg shape mirrors `buildSteps`; `MediaType` union matches route typing in Task 5.
