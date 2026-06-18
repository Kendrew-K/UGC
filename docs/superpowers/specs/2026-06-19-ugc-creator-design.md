# UGC Creator — Design Spec

**Date:** 2026-06-19
**Status:** Approved design, ready for implementation planning

## Summary

A self-hosted tool that turns a client's product photo into ready-to-post UGC
videos. It classifies the product, finds viral TikTok/Instagram Reels videos for
similar products, swaps the original creator's face/body with the client's chosen
face (or an AI-generated avatar) using WAN 2.2 Animate, lightly alters the result
so it looks original, and delivers finished videos to an in-app approval queue for
the client to download and post manually.

Distributed as a GitHub repo. Each client clones it, fills in a `.env`, runs one
command, and uses it in their browser at `localhost:3000`. No hosting, no GPU, no
database server — every heavy step is an external API call.

## Goals

- Demonstrate a working end-to-end UGC generation system.
- Let independent clients self-host their own isolated copy.
- Maximize automation while keeping the client in control (confirm-first, then
  remember).

## Non-Goals (v1)

- Automated posting to social media (client posts manually).
- AI background replacement (only a light distinctiveness pass in v1).
- Multi-tenant SaaS / shared hosting.
- AI voiceover generation (target: music-only / minimal-talking source videos).

## Key Decisions

| Area | Decision |
|------|----------|
| Distribution | Self-hosted local Next.js app, cloned from GitHub, run at `localhost:3000` |
| Stack | Single Next.js (TypeScript) app; SQLite + local filesystem; background job runner |
| Product classification | Claude API (vision) → product type, industry, search keywords |
| Onboarding memory | Confirm questions on first encounter; save answers in SQLite keyed by product type; reuse for variants |
| Face source | Client's uploaded photo OR AI avatar via Banana Pro (Nano Banana Pro) |
| Video sourcing | Apify TikTok + Instagram Reels scrapers; filter ≥1M views, music-only/minimal-talking |
| Face/character swap | WAN 2.2 Animate Replace via fal.ai (`fal-ai/wan/v2.2-14b/animate/replace`) or Replicate (`wan-video/wan-2.2-animate-replace`). `swap` module abstracts the provider behind one interface; final choice (fal.ai vs Replicate) decided by benchmarking both during testing for quality/speed/cost. |
| Distinctiveness | Light ffmpeg pass: color grade + slight crop/zoom + minor speed tweak |
| Delivery | "Ready to Post" approval queue; client downloads + posts manually |
| Cadence | Client sets N videos/week; pipeline keeps the queue topped up |

## Architecture

One self-hosted Next.js app:

- **Frontend (browser):** onboarding, product upload, face-source choice, cadence
  settings, "Ready to Post" approval queue.
- **Backend (Next.js API routes):** orchestrates the pipeline via external APIs.
- **Job runner:** lightweight background worker so the UI never blocks during
  1–2 min swaps.
- **Storage:** SQLite (clients, products, remembered Q&A answers, video jobs,
  statuses) + local filesystem for media.
- **External APIs:** Claude (classify), Apify (scrape), Banana Pro (avatar),
  fal.ai/Replicate (WAN swap).

## Pipeline (data flow)

**Stage 1 — Onboard product (first time only)**
1. Client uploads product photo.
2. Claude vision → product type + industry + suggested keywords.
3. Show detected info + onboarding questions (style, vibe, face source, etc.).
4. Client confirms/edits; answers saved in SQLite keyed by product type. Repeat
   variants skip the questions using saved answers.

**Stage 2 — Source viral videos**
5. Apify (TikTok + Reels) search by keywords; filter ≥1M views, music-only.
6. Download top candidates to local storage.

**Stage 3 — Prepare face**
7. Uploaded photo → use directly. Generate → Banana Pro avatar from prompt.

**Stage 4 — Swap**
8. Per source video: WAN 2.2 Animate Replace (`character image + source video`),
   async submit → poll → fetch result.

**Stage 5 — Distinctiveness pass**
9. ffmpeg: color grade + slight crop/zoom + minor speed tweak.

**Stage 6 — Delivery**
10. Finished video → "Ready to Post" queue. Client reviews, downloads, posts,
    marks done.

## Modules

Each module is isolated, single-purpose, and independently testable.

- `classifier` — Claude vision call → product type/industry/keywords.
- `memory` — read/write remembered Q&A answers by product type (SQLite).
- `scraper` — Apify wrapper: search, filter (≥1M views, music-only), download.
- `face` — resolve face source (uploaded photo or Banana Pro avatar).
- `swap` — WAN 2.2 Animate Replace: submit, poll, fetch.
- `postprocess` — ffmpeg distinctiveness pass.
- `jobs` — pipeline runner / state machine (each video = a job row + status).
- `api` + `ui` — Next.js routes and dashboard.

## Error Handling

- Every video is a **job with a status**: `queued → scraping → swapping →
  processing → ready → failed`. Retryable from where it stopped; no full restart.
- Per-stage catch for API failures (rate limits, NSFW rejects, timeouts); logged
  and surfaced in the dashboard with a retry button.
- A bad swap can be re-run against a different candidate from the scraped batch.

## Configuration (`.env`)

- `ANTHROPIC_API_KEY`
- `APIFY_TOKEN`
- `FAL_KEY` (or `REPLICATE_API_TOKEN`)
- `BANANA_PRO_API_KEY`

## Testing

- Unit tests per module with mocked external APIs (no real spend).
- A few integration tests behind a flag that hit real APIs with one cheap sample.

## Cost Notes (rough, per finished video)

- Scraping source: ~$0.01–$0.05
- WAN 2.2 Animate swap: ~$0.50–$2.00 (dominant cost; depends on length/res)
- Banana Pro avatar (one-time per avatar): ~$0.02–$0.10

## Reference: Higgsfield / WAN findings

- Higgsfield's "Recast" / "Character Swap" is the feature this replicates, but it
  is web-app only (no public API).
- Higgsfield's documented API (`platform.higgsfield.ai`, auth header
  `Authorization: Key {key}:{secret}`, async queue + poll/webhook) covers
  text-to-image and image-to-video only — not Recast.
- Recast is powered by the open-source WAN 2.2 Animate model, which IS available
  via fal.ai and Replicate — the basis for this design's swap engine.
