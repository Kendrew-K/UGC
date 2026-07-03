# Design: Replace Apify TikTok scraper with a Scrapling Python sidecar

Date: 2026-07-03
Raw discovery notes: `brainstorms/2026-07-03-scrapling-tiktok-scraper.md`

## Goal

Replace `src/lib/scraper.ts`'s dependency on the Apify `clockworks/tiktok-scraper` /
`clockworks/tiktok-video-scraper` actors with a self-written scraper built on
[Scrapling](https://github.com/D4Vinci/Scrapling), removing the `APIFY_TOKEN`
dependency. Public API of `scraper.ts` (`Candidate`, `filterViral`,
`findViralVideos`, `resolveVideoUrl`) stays identical so `pipeline.ts` requires
no changes.

## Architecture

**New: `python/tiktok_scraper.py`** — a CLI script using Scrapling's
`StealthyFetcher` to fetch TikTok pages and extract data from the
`__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON blob embedded in the page HTML (the
same data TikTok's own web client renders from).

Two subcommands, both print a single JSON value to stdout and exit non-zero
with a stderr message on failure:

- `python tiktok_scraper.py search "<query>"` → JSON array of candidates:
  `[{url, views, downloadUrl: "", hasVoice, platform: "tiktok", title, hashtags}]`.
  `downloadUrl` is left empty here — no video is downloaded at search time,
  matching current behavior (the approval UI only links to `url` for preview).
- `python tiktok_scraper.py resolve "<tiktokUrl>" "<destPath>"` → downloads the
  actual video file to `destPath` (creating parent dirs as needed) and prints
  `{"path": "<destPath>"}`. This replaces the old `downloadAddr` URL hand-off:
  the sidecar does the real fetch itself (avoiding cross-process cookie/session
  mismatches that plague raw CDN URLs), rather than returning a URL for Node
  to fetch separately.
- `hasVoice`: heuristic `music.original === false` (has a trending/library
  sound → likely no voice-over), matching the fidelity of the previous
  Apify-sourced field.

**`python/requirements.txt`**: `scrapling`.

**`src/lib/scraper.ts` changes**:
- Remove `ApifyClient` import/usage.
- `defaultRun` becomes a function that spawns
  `python python/tiktok_scraper.py search <query>` via `child_process.execFile`
  (or the venv's python if present), parses stdout JSON, maps to `Candidate[]`.
  Non-zero exit or invalid JSON → throw with stderr attached.
- `resolveVideoUrl(tiktokUrl)` becomes: spawn
  `python python/tiktok_scraper.py resolve <tiktokUrl> <destPath>`, return the
  local path. Since `resolveVideoUrl`'s current signature returns a URL
  string (not a destPath), and callers (`pipeline.ts`'s `prepareSource`) need
  the file at a specific `media/jobs/{id}/source.mp4` path anyway, keep the
  function signature `resolveVideoUrl(tiktokUrl: string): Promise<string>`
  but have it write to a fixed temp path under `media/tmp/` and return that
  local path; `downloadTo` (see below) then copies/moves it to the final
  destination like it does for a normal URL today. This keeps `scraper.ts`'s
  public signature unchanged.
- Injectable `run`/spawn dependency retained for unit tests (existing DI
  pattern) — tests never invoke real Python.

**`src/lib/download.ts` changes**: `downloadTo(url, destPath)` detects a local
filesystem path (no `http(s)://` prefix) and copies the file instead of
fetching, then removes the source file (cleanup of the sidecar's temp output).

**`src/lib/jobs.ts` changes**: in `advanceJob`'s `processing` branch, after
computing `finalPath` and before/while updating the DB row to `ready`, delete
`job.source_video_path` and the prior `job.output_path` (the swapped-video
file) from disk. Fully automatic — no new user-facing behavior, just disk
cleanup once a job is done.

**Setup / docs**: README gains a "Python setup" section: install Python 3.10+,
`python -m venv venv`, `pip install -r python/requirements.txt`.
`.env.example` drops `APIFY_TOKEN`.

## Error handling

- Sidecar failures (blocked/rate-limited/parse errors) surface as thrown JS
  errors with the Python stderr message attached — same failure path as
  today's Apify errors, which already propagate into `job.error` via
  `advanceJob`'s catch block. No new retry/proxy logic (explicitly deferred —
  revisit only if scraping breaks often in practice).
- Cleanup deletions are best-effort: wrap in try/catch so a missing/already-
  deleted file never fails the job transition to `ready`.

## Testing

- `scraper.ts`: existing unit tests already inject a fake `run`; add/adjust
  tests for the new spawn-based `defaultRun` and `resolveVideoUrl` using a
  fake spawn function, plus a test that a non-zero exit/bad JSON throws.
- `download.ts`: add a unit test that a local-path input copies instead of
  fetching.
- `jobs.ts`: add a unit test that reaching `ready` deletes the prior
  `source_video_path` and `output_path` files (using a temp dir).
- No integration test against real TikTok/Python (matches the project's
  existing "gated live smoke test" pattern if one is wanted later — out of
  scope here).

## Out of scope (explicitly deferred)

- Retry/proxy/anti-block hardening for the scraper.
- Auto-provisioning the Python venv (client runs the documented manual steps).
- Any change to `evaluator.ts`'s `relevanceScore`/`reason` fields (added after
  scraping, untouched by this change).
