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

**Revision note (2026-07-03, post-implementation):** the original design
below assumed both TikTok pages embed their data as server-rendered JSON.
Live testing against real TikTok proved that wrong for search: the search
page only embeds app config, not results — TikTok loads results via a
client-side XHR call to `/api/search/general/full/` after page load, signed
by TikTok's own JS (`X-Bogus`/`X-Gnarly`). The video-detail page (used by
`resolve`) genuinely does embed full item data server-side, so that half of
the original design held. The sections below describe the **corrected,
live-verified** implementation; strikethrough-style "original plan" text has
been replaced rather than kept, since the corrected version is what shipped.

**New: `python/tiktok_scraper.py`** — a CLI script using Scrapling's
`StealthyFetcher`.

Two subcommands, both print a single JSON value to stdout and exit non-zero
with a stderr message on failure:

- `python tiktok_scraper.py search "<query>"` → JSON array of candidates:
  `[{url, views, downloadUrl: "", hasVoice, platform: "tiktok", title, hashtags}]`.
  Fetches the search page with `capture_xhr='api/search/general/full'` (plus
  `network_idle=True`, a fixed `wait`), which makes Scrapling's browser
  session record the real in-browser API response(s) TikTok's own JS fires
  after page load — this is the only reliable source of search results,
  since they are never present in the initial HTML. Each captured response's
  `data[].item` is mapped to a candidate. `downloadUrl` is left empty here —
  no video is downloaded at search time, matching current behavior (the
  approval UI only links to `url` for preview), and the CDN URL in this
  response is session-bound anyway (see `resolve` below).
- `python tiktok_scraper.py resolve "<tiktokUrl>" "<destPath>"` → downloads the
  actual video file to `destPath` (creating parent dirs as needed) and prints
  `{"path": "<destPath>"}`. The video page **does** embed full item data in
  `__UNIVERSAL_DATA_FOR_REHYDRATION__` (`webapp.video-detail` →
  `itemInfo.itemStruct`), so that part parses as originally planned. But the
  resulting CDN `playAddr` is signed and cookie/session-bound — a fetch from
  outside the browser session that obtained it gets HTTP 403. So the actual
  byte download happens *inside* that same browser session, via a
  `page_action` callback that calls `page.context.request.get(...)` while the
  session is still open, then writes the bytes straight to `destPath`. This
  is a stronger version of the original goal ("avoid cross-process
  cookie/session mismatches") — it turned out to be not just an optimization
  but a hard requirement.
- `hasVoice`: heuristic `music.original === false` (has a trending/library
  sound → likely no voice-over), matching the fidelity of the previous
  Apify-sourced field.
- The `__UNIVERSAL_DATA_FOR_REHYDRATION__` regex must not assume `id` is the
  first attribute on the `<script>` tag — Playwright's DOM serialization
  ordering doesn't match TikTok's raw server HTML, and an order-dependent
  regex silently fails to match on the video-detail page fetched via
  `page_action`.

**`python/requirements.txt`**: `scrapling[fetchers]` (bare `scrapling` omits
`StealthyFetcher`'s dependencies, e.g. `curl_cffi` — confirmed by
`ModuleNotFoundError` during live testing).

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
- `python/test_tiktok_scraper.py`: pure-function unit tests for
  `extract_universal_data`, `parse_search_api_response` (given a fixture
  matching the real `/api/search/general/full/` shape), and
  `parse_video_detail` — no network/browser calls in the test suite itself.
- **Live verification performed 2026-07-03** (not an automated test, a manual
  run against production TikTok): `search "men fit check jacket"` returned 31
  real candidates with correct field shapes; `resolve` on one of those
  candidates downloaded a real, playable 1.68MB `.mp4`. This is what
  surfaced and validated the architecture revision above — the originally
  planned embedded-HTML search parsing produced zero results live, which is
  why it changed.

## Out of scope (explicitly deferred)

- Retry/proxy/anti-block hardening for the scraper.
- Auto-provisioning the Python venv (client runs the documented manual steps).
- Any change to `evaluator.ts`'s `relevanceScore`/`reason` fields (added after
  scraping, untouched by this change).
