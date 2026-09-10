# UGC Creator

Upload a product photo and get TikTok/Reels-ready UGC video back. The app
classifies the product with Claude, scrapes viral clips in that category as
creative references, generates a new video from a description of the chosen
reference using an AI avatar wearing the product, then runs a QC and
distinctiveness pass. Next.js app, Python scraper sidecar, local storage.

## Prerequisites

- **Node.js 20+** ([download](https://nodejs.org/))
- **ffmpeg** installed system-wide (for video processing)
  - On macOS: `brew install ffmpeg`
  - On Ubuntu/Debian: `sudo apt-get install ffmpeg`
  - On Windows: Download from [ffmpeg.org](https://ffmpeg.org/download.html) or use `choco install ffmpeg`
- **Git** ([download](https://git-scm.com/))

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/Kendrew-K/UGC.git
cd UGC
```

### 2. Set Up Environment Variables

Copy the example environment file and fill in your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
# Claude (for product classification)
ANTHROPIC_API_KEY=your-key-here

# Face-swap provider (fal.ai, recommended)
FAL_KEY=your-key-here
SWAP_PROVIDER=fal

# AI avatar generation (KIE.AI — used when client chooses "generate" face)
KIE_API_KEY=your-key-here
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Python setup (TikTok scraper)

The TikTok scraper runs as a small Python sidecar. One-time setup:

1. Install Python 3.10 or newer.
2. From the project root:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r python/requirements.txt
   ```
3. Leave the virtualenv activated (or set `PYTHON_BIN` to its python path)
   whenever you run the app, so `python` on your PATH resolves to this venv.

## How It Works

Generation-only. The viral clip is never reused as pixels, it is only read as a
creative reference and described, then a new video is generated from that
description with the chosen avatar as the base character. That decision is
documented in
[`docs/superpowers/specs/2026-07-25-remake-only-generation-design.md`](docs/superpowers/specs/2026-07-25-remake-only-generation-design.md):
the earlier face-swap path kept leaking artifacts (mismatched clothing, garbled
mirror reflections, extra limbs) because it reused source pixels, and it forced
a strict source-suitability gate that threw away most viral candidates anyway.

```
1. Upload product photo          src/app/api/products
   -> Claude classifies the product and its category      src/lib/classifier.ts

2. Scrape viral references       python/tiktok_scraper.py (Scrapling sidecar)
   -> ranked by virality, filtered to industry/activity    src/lib/scraper.ts

3. Client picks an avatar        src/lib/avatar.ts
   -> generated, or supplied; dressed in the product       src/lib/tryon.ts

4. Describe the reference        src/lib/describe.ts
   -> frame-by-frame, with explicit lighting/color/texture

5. Generate from the description src/lib/generate.ts
   -> brand-new video or picture; no source pixels reused

6. QC and distinctiveness pass   src/lib/qc.ts, src/lib/postprocess.ts
   -> ffmpeg post-processing, automated quality check      src/lib/evaluator.ts

7. Ready to post                 /ready
   -> manual download and upload. Nothing posts by itself.
```

`src/lib/pipeline.ts` assembles these into the step list for a job
(`buildRemakeSteps` for video, `buildPictureRemakeSteps` for pictures);
`src/lib/jobs.ts` runs them and records progress.

## Workflow

1. **Upload**: Browse to localhost:3000 and upload a product photo.
2. **Process**: The pipeline runs automatically—monitor progress in the UI.
3. **Review**: Generated videos appear in the "Ready to Post" queue at `/ready`.
4. **Post Manually**: Download and post videos to TikTok, Instagram Reels, or your platform of choice. *No automatic posting.*

## Tests

```bash
npm test          # vitest, unit tests, no network
npm run lint
```

Provider calls (fal, KIE, Anthropic) are injected, so the suite runs offline.
`src/lib/integration.live.test.ts` is the exception: it hits real providers and
costs credits, so it is opt-in and not part of `npm test`.

## Storage

All media files and database records are stored locally in the `media/` directory (git-ignored). No data leaves your machine.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for product classification |
| `FAL_KEY` | If `SWAP_PROVIDER=fal` | FAL API key for face-swap |
| `REPLICATE_API_TOKEN` | If `SWAP_PROVIDER=replicate` | Replicate API key for face-swap |
| `BANANA_PRO_API_KEY` | No | Banana API key for video distinctiveness |
| `SWAP_PROVIDER` | No | Which face-swap service to use (`fal` or `replicate`, default: `fal`) |
| `PYTHON_BIN` | No | Path to Python executable for the TikTok scraper sidecar (default: `python` on PATH) |
| `UGC_DB_PATH` | No | SQLite file for jobs, products and avatars (default: `media/app.sqlite`) |
| `KIE_I2V_MODEL` | No | Override the image-to-video model (default: `kling-2.6/image-to-video`) |
| `KIE_IMAGE_MODEL` | No | Override the image model for picture output (default: `google/nano-banana-edit`) |
| `NEXT_PUBLIC_JOB_LABEL` | No | What a pipeline run is called in the UI (default: `Job`) |

Test-only flags, none needed to run the app: `RUN_LIVE_TESTS`, `RUN_FACE_SRC`
and `RUN_PRODUCT_ID` gate `src/lib/integration.live.test.ts`, which spends real
provider credits. `E2E_JOB`, `E2E_MEDIA` and `E2E_PICK` drive
`scripts/e2e-driver.mjs`.

## Troubleshooting

**ffmpeg not found**: Ensure ffmpeg is installed and available in your system PATH. Test with `ffmpeg -version`.

**API key errors**: Double-check that all required keys in `.env` are filled in and valid.

**Out of memory**: If processing large batches, the service may run out of memory. Restart with `npm run dev`.

## Notes

- Nothing posts automatically. Generated videos land in `/ready` for manual
  download and upload; auto-posting is a ban risk on every platform.
- `media/` and the Python `venv/` are gitignored. Both are recreated by the
  setup steps and the pipeline, and together they run to hundreds of MB.
- TikTok scraping is inherently brittle. When the page shape changes the
  sidecar returns nothing rather than guessing, and the job stops at that step.
