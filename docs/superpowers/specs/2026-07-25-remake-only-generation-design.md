# Remake-Only Generation Pipeline — Design

> Date: 2026-07-25
> Status: approved (brainstorm), pending implementation plan
> Supersedes the face-swap approach for both video and picture output.

## Motivation

Face-swap output (WAN video swap, nano-banana photo swap) kept producing
sub-par results: disappearing/ mismatched clothing, garbled mirror reflections,
extra limbs/feet, second-person bleed. Every failure traces to *reusing source
pixels* from a viral clip. The swap path also forces a strict source-suitability
gate (no mirrors, no second person, no occlusion, no busy backgrounds), which
throws away most viral candidates and still leaks artifacts.

"Remake" mode already sidesteps all of this: it treats the viral clip as a
*creative reference only*, describes it, and generates a brand-new AI video from
the description using the client's chosen avatar as the base character. No source
pixels are reused, so none of the swap artifacts or source constraints apply.

This design **retires face-swap entirely** and makes generation-from-description
the only path — for both video and pictures — then loosens candidate filtering,
enriches the description, and tunes the generation prompt for human realism.

## Goals

1. Delete both swap paths (video-swap, photo-swap) and their providers.
2. Two output modes, both generation-based: **video** and **picture**.
3. Loosen candidate filtering to industry/activity match, ranked by virality.
4. Richer frame-by-frame description with explicit lighting/color/texture.
5. More human-realistic output via a realism-tuned generation prompt (prompt-first;
   keep proven models).

## Non-goals

- No new/premium generation models this pass (revisit only if prompt-first
  realism proves insufficient).
- No heavy ffmpeg realism grading beyond the existing `distinctify` pass.
- No change to classification, avatar creation, scraping transport, or the
  approval gate (client still picks which viral reference).

## Architecture

Single generation philosophy across both modes:

```
product photo → classify → scrape viral refs → rank (loose, virality)
  → client approves one reference (approval gate, unchanged)
  → dress avatar in product (tryon, unchanged)
  → DESCRIBE the reference (video: 14 frames; picture: 1 frame)
  → BUILD realism-tuned generation prompt from the brief
  → GENERATE new media (video: Kling i2v; picture: nano-banana edit on avatar)
  → QC output → distinctify → ready
```

### Modules deleted

- `src/lib/swap/` — entire directory: `fal.ts`, `replicate.ts`, `kie.ts`
  (swap provider), `types.ts`, `index.ts`, `index.test.ts`, `fal.test.ts`.
- `src/lib/imageswap.ts` + `src/lib/imageswap.test.ts`.
- `pipeline.ts`: `buildSteps` (video-swap), `buildPictureSteps` (photo-swap),
  and their `PipelineDeps` / `PicturePipelineDeps` interfaces.
- `qc.ts`: `checkSourceSuitability` (swap-only source-frame gate) + its tests.

### Modules kept (unchanged unless noted)

- `tryon.ts` (`dressAvatar`) — avatar is still dressed in the product before
  generation; the generator renders whatever the avatar image wears.
- `generate.ts` (`generateVideoFromImage`, Kling 2.6 i2v).
- `describe.ts` — enriched (see below).
- `evaluator.ts` — loosened (see below).
- `kie.ts` (`runKieTask`, `kieUpload`) — the KIE task runner (distinct from the
  deleted `swap/kie.ts` provider).
- `scraper.ts`, `postprocess.ts` (`distinctify`, `distinctifyImage`), `face.ts`,
  `download.ts`.
- `qc.ts`: `checkVideoQuality`, `checkImageQuality`, `checkAvatarIdentity`,
  `extractFrames`.

### Modules added

- `pipeline.ts`: `buildPictureRemakeSteps` — picture counterpart of
  `buildRemakeSteps`. Describes a viral *photo*, builds an image prompt, and
  generates a new photo by editing the dressed-avatar image into the described
  scene/pose via the nano-banana edit model (avatar image + scene prompt — a
  generation, **not** a person-swap). Then QC image → distinctify.

## Component detail

### Candidate filtering (`evaluator.ts`)

Collapse to one rubric (drop the swap vs remake split):

- **Remove** the exact-product-type requirement. Match at industry/activity
  level: a lipstick may borrow any viral *makeup* video.
- **Keep** gender match.
- **Hard-reject (score 0-2) only**: collage/grid layouts, multi-clip
  compilations, no person visible. (These describe and generate badly regardless
  of swap.) Mirrors, second people, occlusion, busy backgrounds are all fine —
  nothing is reused but the ideas.
- **Rank** by virality: views-weighted score, as today
  (`score * log(views+1)`), with a lowered `MIN_SCORE`.
- **Delete** the `MAX_CLIP_SECONDS` length filter (a swap-only concern; a brief
  just samples frames).

### Description (`describe.ts`)

- Frame count 8 → **14** (finer temporal resolution for the beat timeline).
- `VideoBrief` gains:
  - `lighting: { direction: string; quality: string }` (e.g. "key light
    front-left", "soft diffused").
  - `colorGrade: string` (e.g. "warm, slightly lifted blacks, teal shadows").
  - `skinTexture: string` (e.g. "natural pores, minimal retouch").
  - `beats: Array<{ t: string; action: string }>` — per-moment timeline,
    replacing the flat `subjectMotion: string[]`.
- New `PhotoBrief` — single-frame variant (no `beats`, no camera movement):
  `summary`, `subject`, `scene`, `spatialFraming`, `lighting`, `colorGrade`,
  `skinTexture`, `whatMakesItWork`, `differentiationSeeds`.
- `describeReferencePhoto(photoPath)` — the picture analogue of
  `describeReferenceVideo`, one frame in, `PhotoBrief` out.
- Fail-closed behavior preserved: any parse/validation problem throws.

### Generation prompt (`describe.ts`)

- `buildGenerationPrompt(brief)` (video): inject `lighting`, `colorGrade`,
  `skinTexture`, and the `beats` timeline; append a realism suffix — natural
  skin with visible pores, soft directional light, subtle film grain, slight
  handheld micro-shake, no plastic/AI sheen, no on-screen text.
- `buildPhotoPrompt(brief)` (picture): same realism cues, phrased for a still —
  scene/pose/framing/lighting from the `PhotoBrief`, avatar identity + outfit
  from the reference image, photorealistic, no on-screen text.

### Picture generation (`buildPictureRemakeSteps`)

1. `findCandidates` — `findViralPhotos` + loosened `rankCandidates`.
2. `prepareSource` — download the photo (no source-suitability gate).
3. `swap` step slot (the transform): `describeReferencePhoto` →
   `buildPhotoPrompt` → dress avatar (if product photo present) → nano-banana
   edit (dressed avatar image + photo prompt) → download → `checkImageQuality`;
   one auto-reroll on QC failure (image gen is cheap), else fail to approval.
4. `process` — `distinctifyImage` → `final.jpg`.

### Status rename

Job status `swapping` → `generating` across the state machine, DB writes, and UI
labels (nothing swaps anymore). `downloading → generating → processing → ready`.

### UI

Media-type selector drops from three options (video / picture / remake) to two
(**video / picture**) — both are generation-based, so "remake" leaves the UI.
Approval gate and the rest of `ProductUpload` / `JobQueue` unchanged.

## Data flow (video mode, end to end)

```
POST /api/products  → classify → product row
POST /api/jobs {mediaType: 'video'} → job (queued)
advance: queued → (find + rank) → awaiting_approval
approve {chosenIndex} → downloading (download ref clip, no source gate)
advance: → generating (describe 14 frames → prompt → dress avatar → Kling i2v
          → QC video, 1 reroll) → processing (distinctify) → ready
```

Picture mode is identical with `findViralPhotos`, `describeReferencePhoto`,
`buildPhotoPrompt`, nano-banana edit, and `checkImageQuality`.

## Error handling

- Description parse/validation failure → throw (fail closed; a wrong brief burns
  a paid generation).
- Generation QC failure → one auto-reroll (generation is cheap, ~$0.25-0.55),
  then revert to `awaiting_approval` with the QC reason so the client can pick a
  different reference.
- Empty candidate set after ranking → job fails with a clear message.
- Avatar identity check after dressing → one reroll of the dress step, then fail.

## Testing (TDD, block by block)

- `evaluator.ts`: loosened rubric filters collages/no-person, keeps mirrors/
  second-person, drops exact-product and length filters. Mocked Claude.
- `describe.ts`: enriched `VideoBrief` + new `PhotoBrief` parse/validate; missing
  new fields throw; prompt builders include lighting/color/texture + realism
  suffix. Mocked client + frame extractor.
- `pipeline.ts`: `buildPictureRemakeSteps` happy path + QC-reroll + describe-fail,
  all deps mocked. Existing `buildRemakeSteps` tests adjusted for enriched brief.
- Regression: deleting swap modules must not break `jobs`/route tests; update the
  media-type set and status name in those tests.
- Live smoke (gated, manual): one video remake + one picture remake to `ready`.

## Open questions

None blocking. Model upgrades deferred; if prompt-first realism is judged
insufficient after a live run, revisit §Realism with a benchmark of premium
video/image models.
