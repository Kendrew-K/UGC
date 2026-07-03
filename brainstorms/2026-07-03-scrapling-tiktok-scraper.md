# Scrapling TikTok Scraper: Brainstorm / Discovery Notes
Date: 2026-07-03 · Goal: replace Apify-based TikTok scraping in src/lib/scraper.ts with a Python sidecar using Scrapling (github.com/D4Vinci/Scrapling)

## Summary / key decisions
- Scrapling is a generic stealth-fetch/parse library, not a TikTok-specific API — we write our own TikTok search/parse logic on top of it.
- Approach: Python sidecar script (`python/tiktok_scraper.py`) invoked via child_process from Node; client machines must install Python + `pip install -r python/requirements.txt` (accepted setup cost, documented in README, not auto-bundled).
- Scraping method: fetch TikTok's web search page with Scrapling's StealthyFetcher, parse the embedded JSON blob (`__UNIVERSAL_DATA_FOR_REHYDRATION__` / SIGI_STATE) for itemList entries.
- `hasVoice` heuristic: `music.original === false` → likely no voice-over (best-effort, same fidelity as prior Apify field).
- `src/lib/scraper.ts` keeps its existing public shape (`Candidate`, `filterViral`, `findViralVideos`, `resolveVideoUrl`) so `pipeline.ts` needs no changes; internals swap ApifyClient calls for child_process calls to the sidecar.

## Q&A log
### Q1 — TikTok anti-bot / legal / fragility posture
- Asked: DIY scraping is fragile vs Apify's maintained actor; accept the tradeoff, and how should failures be handled (retries/proxies now vs later)?
- Captured: Accept the tradeoff for now; revisit/change approach later if it becomes a real problem. No retry/proxy logic needed now — just fail clearly, not silently.
- Flags: none

### Q2 — Video file download mechanics
- Asked: playAddr URLs are often short-lived/signed/cookie-bound — should the Python sidecar download the actual video bytes itself, or just hand Node a URL for the existing `downloadTo` to fetch?
- Captured: Sidecar downloads the full video itself (fetches the actual video file, not just a URL), avoiding cross-process cookie/header mismatch. Reports back a local file path.
- Flags: this changes `Candidate.downloadUrl` semantics — need to decide (Q-next) whether it becomes a local path or we keep a `downloadUrl` field name but populate it with a `file://` path, and how `resolveVideoUrl`/`pipeline.ts`'s `d.download(dlUrl, sourcePath)` step adapts (may become a copy/move instead of an HTTP download).

### Q3 — Reconciling local-file downloads with pipeline.ts
- Asked: keep `downloadUrl` field name holding either an http(s) URL or a local file path, and make `downloadTo` copy when given a local path (zero changes to pipeline.ts) vs. rename/rework fields explicitly?
- Captured: Go with the recommendation — `downloadUrl` can hold a local path; `download.ts`'s `downloadTo` detects local paths and copies instead of fetching. `pipeline.ts` stays untouched.
- Flags: none

### Q4 — Temp file location & cleanup
- Asked: where should downloaded video temp files live and who cleans them up?
- Captured: Investigated approval UI (JobQueue.tsx) — it only links to the original TikTok page URL for preview, never downloads video during search/candidate listing. So only ONE video is ever downloaded per job: the chosen candidate, during `prepareSource`. Sidecar's "resolve" command will take the destination path directly (`media/jobs/{id}/source.mp4`) and write straight there — no separate temp file or copy step needed.
- Follow-up: user wants intermediates (`source.mp4`, `swapped.mp4`) deleted once a job reaches `ready` status, keeping only `final.mp4`. User confirmed: fold this into the same spec, keep it as simple as possible for the user (automatic, no manual step).
- Flags: none (resolved below)

### Q4b — Where to hook cleanup (self-answered via code read)
- Read `src/lib/jobs.ts` `advanceJob`: the `processing` branch computes `finalPath` and sets `output_path` to it (overwriting the prior swapped-video path). Simplest hook: right after computing `finalPath`, delete `job.source_video_path` and the old `job.output_path` (the swapped file) before overwriting the DB row. Fully automatic, zero new user-facing surface — exactly the "simple for the user" ask.
- Captured: proceed with this approach, no separate question needed.

### Q5 — relevanceScore/reason fields (self-answered via code read)
- Checked `evaluator.ts`: `ScoredCandidate = Candidate & { relevanceScore, reason }` is added post-scraping by Claude-based evaluator, not part of scraper output. No changes needed to `Candidate` type beyond what's already there (`url, views, downloadUrl, hasVoice, platform, title?, hashtags?`).
- Captured: confirmed, no open question.

## Open flags (pending input)
- None outstanding — ready to write the design doc.
