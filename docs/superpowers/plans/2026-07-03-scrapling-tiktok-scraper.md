# Scrapling TikTok Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Apify-based TikTok scraper in `src/lib/scraper.ts` with a
Python sidecar (`python/tiktok_scraper.py`) built on Scrapling, remove the
`APIFY_TOKEN` dependency, and clean up intermediate media files once a job
reaches `ready`.

**Architecture:** A Python CLI script uses Scrapling's `StealthyFetcher` to
fetch TikTok pages and parse the `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON
blob embedded in the HTML. Node's `scraper.ts` spawns this script via
`child_process.execFile` and parses its JSON stdout. `download.ts` gains
local-file-path support so the sidecar's downloaded file can be "copied" into
place with the same code path used for HTTP downloads today. `jobs.ts` deletes
intermediate files once a job's pipeline reaches `ready`.

**Tech Stack:** TypeScript (Node, vitest), Python 3.10+ (Scrapling, stdlib
`unittest`), existing `child_process` (Node stdlib).

## Global Constraints

- `scraper.ts`'s public API (`Candidate`, `filterViral`, `findViralVideos`,
  `resolveVideoUrl`) must not change shape — `pipeline.ts` gets zero edits.
- No retry/proxy/anti-block logic — failures throw, same as today's Apify
  errors.
- Cleanup deletions must be best-effort (never fail a job transition if a
  file is already gone).
- Field paths for TikTok's embedded JSON (`__DEFAULT_SCOPE__` structure) are
  based on the known public shape of TikTok's web client; this is inherently
  fragile and accepted as a tradeoff (see spec) — write it clearly enough
  that fixing broken selectors later is a one-function change.

---

### Task 1: Python sidecar — JSON parsing (pure functions, no network)

**Files:**
- Create: `python/tiktok_scraper.py`
- Create: `python/requirements.txt`
- Test: `python/test_tiktok_scraper.py`

**Interfaces:**
- Produces: `extract_universal_data(html: str) -> dict`,
  `parse_search_results(html: str) -> list[dict]` (each dict:
  `{url, views, downloadUrl, hasVoice, platform, title, hashtags}`,
  `downloadUrl` always `""`), `parse_video_detail(html: str) -> dict`
  (`{downloadUrl: str}`).

- [ ] **Step 1: Write `python/requirements.txt`**

```
scrapling
```

- [ ] **Step 2: Write the failing test for JSON extraction**

```python
# python/test_tiktok_scraper.py
import unittest
from tiktok_scraper import extract_universal_data, parse_search_results, parse_video_detail

SEARCH_HTML = '''<html><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
{"__DEFAULT_SCOPE__": {"webapp.search-detail": {"searchResult": {"item_list": [
  {"id": "123", "desc": "cool jacket #fit", "stats": {"playCount": 5000000},
   "video": {"playAddr": "https://cdn.example/v1.mp4"},
   "music": {"original": false},
   "challenges": [{"title": "fit"}],
   "author": {"uniqueId": "someuser"}}
]}}}}
</script>
</body></html>'''

VIDEO_HTML = '''<html><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
{"__DEFAULT_SCOPE__": {"webapp.video-detail": {"itemInfo": {"itemStruct":
  {"video": {"playAddr": "https://cdn.example/v2.mp4"}}
}}}}
</script>
</body></html>'''


class TestExtractUniversalData(unittest.TestCase):
    def test_extracts_embedded_json(self):
        data = extract_universal_data(SEARCH_HTML)
        self.assertIn('__DEFAULT_SCOPE__', data)

    def test_raises_when_blob_missing(self):
        with self.assertRaises(ValueError):
            extract_universal_data('<html><body>no data here</body></html>')


class TestParseSearchResults(unittest.TestCase):
    def test_maps_items_to_candidates(self):
        candidates = parse_search_results(SEARCH_HTML)
        self.assertEqual(len(candidates), 1)
        c = candidates[0]
        self.assertEqual(c['url'], 'https://www.tiktok.com/@someuser/video/123')
        self.assertEqual(c['views'], 5000000)
        self.assertEqual(c['downloadUrl'], '')
        self.assertTrue(c['hasVoice'])  # music.original == False -> no known sound -> voice heuristic true
        self.assertEqual(c['platform'], 'tiktok')
        self.assertEqual(c['title'], 'cool jacket #fit')
        self.assertEqual(c['hashtags'], ['fit'])


class TestParseVideoDetail(unittest.TestCase):
    def test_extracts_download_url(self):
        result = parse_video_detail(VIDEO_HTML)
        self.assertEqual(result['downloadUrl'], 'https://cdn.example/v2.mp4')


if __name__ == '__main__':
    unittest.main()
```

Note: the `hasVoice` heuristic is `music.original is False` means the clip
uses a *known/trending* sound (i.e., not a custom/original audio track the
creator recorded, which is usually voice-over) → `hasVoice = not original`.

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m unittest python/test_tiktok_scraper.py -v` (from repo root,
run as `python -m unittest discover -s python -p "test_*.py"`)
Expected: FAIL with `ModuleNotFoundError: No module named 'tiktok_scraper'`

- [ ] **Step 4: Write the implementation**

```python
# python/tiktok_scraper.py
"""CLI: search TikTok or resolve+download a single video, using Scrapling."""
import json
import re
import sys
from pathlib import Path

REHYDRATION_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
    re.S,
)


def extract_universal_data(html: str) -> dict:
    match = REHYDRATION_RE.search(html)
    if not match:
        raise ValueError('__UNIVERSAL_DATA_FOR_REHYDRATION__ not found in page')
    return json.loads(match.group(1))


def parse_search_results(html: str) -> list[dict]:
    data = extract_universal_data(html)
    items = (
        data.get('__DEFAULT_SCOPE__', {})
        .get('webapp.search-detail', {})
        .get('searchResult', {})
        .get('item_list', [])
    )
    candidates = []
    for item in items:
        author = item.get('author', {}).get('uniqueId', '')
        video_id = item.get('id', '')
        original_sound = item.get('music', {}).get('original', True)
        candidates.append({
            'url': f'https://www.tiktok.com/@{author}/video/{video_id}',
            'views': item.get('stats', {}).get('playCount', 0),
            'downloadUrl': '',
            'hasVoice': not original_sound,
            'platform': 'tiktok',
            'title': item.get('desc', ''),
            'hashtags': [c.get('title', '') for c in item.get('challenges', [])],
        })
    return candidates


def parse_video_detail(html: str) -> dict:
    data = extract_universal_data(html)
    item = (
        data.get('__DEFAULT_SCOPE__', {})
        .get('webapp.video-detail', {})
        .get('itemInfo', {})
        .get('itemStruct', {})
    )
    download_url = item.get('video', {}).get('playAddr', '')
    if not download_url:
        raise ValueError('no downloadable video URL found on page')
    return {'downloadUrl': download_url}


def cmd_search(query: str) -> None:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(f'https://www.tiktok.com/search?q={query}')
    print(json.dumps(parse_search_results(page.html_content)))


def cmd_resolve(tiktok_url: str, dest_path: str) -> None:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(tiktok_url)
    info = parse_video_detail(page.html_content)
    video_page = StealthyFetcher.fetch(info['downloadUrl'])
    Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
    Path(dest_path).write_bytes(video_page.body)
    print(json.dumps({'path': dest_path}))


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        if command == 'search':
            cmd_search(sys.argv[2])
        elif command == 'resolve':
            cmd_resolve(sys.argv[2], sys.argv[3])
        else:
            print(f'unknown command: {command}', file=sys.stderr)
            sys.exit(1)
    except Exception as exc:  # surfaced to Node as stderr + non-zero exit
        print(str(exc), file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m unittest discover -s python -p "test_*.py" -v`
Expected: all 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add python/tiktok_scraper.py python/requirements.txt python/test_tiktok_scraper.py
git commit -m "feat: add Scrapling-based TikTok scraper Python sidecar"
```

---

### Task 2: `download.ts` — support local-path "downloads" (copy instead of fetch)

**Files:**
- Modify: `src/lib/download.ts`
- Test: `src/lib/download.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `downloadTo(urlOrPath: string, destPath: string, deps?): Promise<string>`
  — unchanged signature, but now also accepts a local filesystem path (no
  `http://`/`https://` prefix) and copies+removes the source file instead of
  fetching.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/lib/download.test.ts
it('copies a local file path instead of fetching, and removes the source', async () => {
  const src = 'media/test-out/local-src.bin';
  fs.mkdirSync('media/test-out', { recursive: true });
  fs.writeFileSync(src, Buffer.from([9, 9, 9]));
  const out = await downloadTo(src, 'media/test-out/copied.bin');
  expect(out).toBe('media/test-out/copied.bin');
  expect(fs.readFileSync('media/test-out/copied.bin')).toEqual(Buffer.from([9, 9, 9]));
  expect(fs.existsSync(src)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/download.test.ts`
Expected: FAIL — current `downloadTo` calls `fetch('media/test-out/local-src.bin')` and throws/errors.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/download.ts
import fs from 'node:fs';
import path from 'node:path';

export async function downloadTo(
  urlOrPath: string,
  destPath: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<string> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!/^https?:\/\//i.test(urlOrPath)) {
    fs.copyFileSync(urlOrPath, destPath);
    fs.rmSync(urlOrPath, { force: true });
    return destPath;
  }
  const f = deps.fetchImpl ?? fetch;
  const res = await f(urlOrPath);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/download.test.ts`
Expected: PASS (both the existing HTTP test and the new local-path test)

- [ ] **Step 5: Commit**

```bash
git add src/lib/download.ts src/lib/download.test.ts
git commit -m "feat: downloadTo copies local file paths instead of fetching"
```

---

### Task 3: `scraper.ts` — replace Apify with the Python sidecar

**Files:**
- Modify: `src/lib/scraper.ts`
- Test: `src/lib/scraper.test.ts`
- Modify: `.env.example` (drop `APIFY_TOKEN`)
- Modify: `package.json` (remove `apify-client` dependency) — only if no
  other module imports it; check first.

**Interfaces:**
- Consumes: none new (still spawns a child process internally).
- Produces: `Candidate`, `filterViral`, `findViralVideos(searchQueries, deps?)`,
  `resolveVideoUrl(tiktokUrl: string): Promise<string>` — all unchanged
  signatures. `resolveVideoUrl` now returns a **local file path** (it writes
  to `media/tmp/<random>.mp4`) instead of a CDN URL; callers already pass
  whatever `resolveVideoUrl` returns straight into `downloadTo` (Task 2 makes
  that copy-safe).

- [ ] **Step 1: Check for other `apify-client` usages**

Run: `grep -rl "apify-client" src/` (or use the Grep tool)
Expected: only `src/lib/scraper.ts` — if other files use it, do not remove
the dependency in this task; note it and move on.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/lib/scraper.test.ts — replace the whole file
import { describe, it, expect } from 'vitest';
import { filterViral, findViralVideos, resolveVideoUrl, type Candidate } from './scraper';

const c = (views: number, hasVoice: boolean): Candidate => ({
  url: 'u', views, downloadUrl: 'd', hasVoice, platform: 'tiktok',
});

describe('filterViral', () => {
  it('drops sub-1M and voiced clips, sorts by views desc', () => {
    const out = filterViral([c(2_000_000, false), c(500_000, false), c(3_000_000, true), c(5_000_000, false)]);
    expect(out.map((x) => x.views)).toEqual([5_000_000, 2_000_000]);
  });
});

describe('findViralVideos', () => {
  it('passes searchQueries to the runner and filters results', async () => {
    const run = async () => [c(9_000_000, false), c(10, false)];
    const out = await findViralVideos(['men fit check jacket'], { run });
    expect(out).toHaveLength(1);
    expect(out[0].views).toBe(9_000_000);
  });

  it('throws when the sidecar process fails', async () => {
    const run = async (): Promise<Candidate[]> => { throw new Error('sidecar exited 1: blocked'); };
    await expect(findViralVideos(['q'], { run })).rejects.toThrow(/blocked/);
  });
});

describe('resolveVideoUrl', () => {
  it('returns whatever local path the sidecar resolver reports', async () => {
    const resolve = async (_url: string) => 'media/tmp/abc123.mp4';
    const out = await resolveVideoUrl('https://www.tiktok.com/@x/video/1', { resolve });
    expect(out).toBe('media/tmp/abc123.mp4');
  });

  it('throws when the sidecar resolver fails', async () => {
    const resolve = async (): Promise<string> => { throw new Error('resolve failed: 404'); };
    await expect(
      resolveVideoUrl('https://www.tiktok.com/@x/video/1', { resolve })
    ).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/scraper.test.ts`
Expected: FAIL — `resolveVideoUrl` doesn't accept a `deps` param yet.

- [ ] **Step 4: Write the implementation**

```typescript
// src/lib/scraper.ts
/**
 * Scraper — finds viral TikTok clips via a Python sidecar (Scrapling-based)
 * that scrapes TikTok's search/video pages directly.
 * Owns: search query execution, raw item mapping, virality filtering.
 * Does NOT: evaluate relevance or persist results.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Candidate = {
  url: string;
  views: number;
  downloadUrl: string;
  hasVoice: boolean;
  platform: 'tiktok' | 'reels';
  title?: string;
  hashtags?: string[];
};

export type ScraperSearch = (searchQuery: string) => Promise<Candidate[]>;
export type ScraperResolve = (tiktokUrl: string) => Promise<string>;

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python';
const SIDECAR_PATH = 'python/tiktok_scraper.py';

async function runSidecar(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [SIDECAR_PATH, ...args]);
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    throw new Error(`tiktok_scraper.py failed: ${stderr || (err as Error).message}`);
  }
}

const defaultSearch: ScraperSearch = async (searchQuery) => {
  const stdout = await runSidecar(['search', searchQuery]);
  return JSON.parse(stdout) as Candidate[];
};

const defaultResolve: ScraperResolve = async (tiktokUrl) => {
  const destPath = `media/tmp/${randomUUID()}.mp4`;
  await runSidecar(['resolve', tiktokUrl, destPath]);
  return destPath;
};

/**
 * Keeps only clips with at least `minViews` views and no voice-over,
 * sorted highest-views first.
 */
export function filterViral(items: Candidate[], minViews = 1_000_000): Candidate[] {
  return items
    .filter((i) => i.views >= minViews && i.hasVoice === false)
    .sort((a, b) => b.views - a.views);
}

/**
 * Resolves a local file path for a TikTok post URL by downloading the video
 * via the Python sidecar (avoids cross-process cookie/session mismatches
 * that plague raw CDN URLs fetched from a separate process).
 *
 * @param tiktokUrl - The full TikTok post URL (e.g. https://www.tiktok.com/@user/video/123)
 * @param deps.resolve - injectable resolver for tests; defaults to the real sidecar
 */
export async function resolveVideoUrl(
  tiktokUrl: string,
  deps: { resolve?: ScraperResolve } = {}
): Promise<string> {
  const resolve = deps.resolve ?? defaultResolve;
  return resolve(tiktokUrl);
}

/**
 * Runs `searchQueries` through the Python sidecar and returns viral,
 * voice-free candidates sorted by view count descending.
 *
 * @param searchQueries - TikTok search terms (e.g. ["men fit check jacket"])
 * @param deps.run - injectable runner for tests; defaults to the real sidecar
 */
export async function findViralVideos(
  searchQueries: string[],
  deps: { run?: (input: { searchQueries: string[] }) => Promise<Candidate[]> } = {}
): Promise<Candidate[]> {
  const run =
    deps.run ??
    (async ({ searchQueries: queries }) => {
      const results = await Promise.all(queries.map((q) => defaultSearch(q)));
      return results.flat();
    });
  return filterViral(await run({ searchQueries }));
}
```

Note: this keeps `findViralVideos`'s existing `{ run }` DI shape (test 1 in
Step 2 already relies on that), and adds a separate `{ resolve }` DI shape for
`resolveVideoUrl` matching the new test in Step 2.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/scraper.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 6: Update `.env.example`**

Remove the `APIFY_TOKEN=` line from `.env.example`.

- [ ] **Step 7: Remove `apify-client` dependency (only if Step 1 confirmed no other usages)**

```bash
npm uninstall apify-client
```

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS (check `pipeline.test.ts` still passes unchanged,
since `pipeline.ts` itself wasn't touched)

- [ ] **Step 9: Commit**

```bash
git add src/lib/scraper.ts src/lib/scraper.test.ts .env.example package.json package-lock.json
git commit -m "feat: replace Apify TikTok scraper with Scrapling Python sidecar"
```

---

### Task 4: `jobs.ts` — delete intermediate files once a job reaches `ready`

**Files:**
- Modify: `src/lib/jobs.ts`
- Test: `src/lib/jobs.test.ts`

**Interfaces:**
- Consumes: `job.source_video_path`, `job.output_path` (existing DB columns,
  read inside `advanceJob`).
- Produces: no new exported symbols; `advanceJob` gains a side effect (best-
  effort file deletion) when transitioning `processing` → `ready`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/lib/jobs.test.ts
it('deletes intermediate source/swapped files once the job reaches ready', async () => {
  const db = getDb(':memory:');
  const id = seedJobWithFace(db);
  const sourcePath = 'media/test-cleanup/src.mp4';
  const swappedPath = 'media/test-cleanup/swapped.mp4';
  fs.mkdirSync('media/test-cleanup', { recursive: true });
  fs.writeFileSync(sourcePath, 'x');
  fs.writeFileSync(swappedPath, 'x');

  await advanceJob(db, id, okSteps); // -> awaiting_approval
  approveCandidate(db, id, 0); // -> downloading
  await advanceJob(db, id, { ...okSteps, prepareSource: async () => sourcePath }); // -> swapping
  await advanceJob(db, id, { ...okSteps, swap: async () => swappedPath }); // -> processing
  await advanceJob(db, id, { ...okSteps, process: async () => 'media/test-cleanup/final.mp4' }); // -> ready

  expect(fs.existsSync(sourcePath)).toBe(false);
  expect(fs.existsSync(swappedPath)).toBe(false);
  fs.rmSync('media/test-cleanup', { recursive: true, force: true });
});
```

Add `import fs from 'node:fs';` to the top of `src/lib/jobs.test.ts` if not
already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: FAIL — files still exist after reaching `ready`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/jobs.ts — modify the `processing` branch inside advanceJob
    if (status === 'processing') {
      const finalPath = await steps.process(job.output_path);
      // Best-effort cleanup: intermediates are no longer needed once ready.
      for (const p of [job.source_video_path, job.output_path]) {
        if (p) {
          try {
            fs.rmSync(p, { force: true });
          } catch {
            // ignore — cleanup must never fail the job transition
          }
        }
      }
      setJob(db, jobId, { status: 'ready', output_path: finalPath });
      return 'ready';
    }
```

Add `import fs from 'node:fs';` to the top of `src/lib/jobs.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: all tests PASS, including the existing `output_path` assertion
(`row.output_path` still equals `finalPath` since deletion happens before the
`setJob` call, using the pre-overwrite value)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs.ts src/lib/jobs.test.ts
git commit -m "feat: delete intermediate job media files once a job reaches ready"
```

---

### Task 5: Documentation — Python setup instructions

**Files:**
- Modify: `README.md` (add a "Python setup" section near existing setup
  instructions)

**Interfaces:** none (docs only).

- [ ] **Step 1: Find the current setup section**

Run: `grep -n "## Setup\|## Getting Started\|npm install" README.md` (or use
Grep tool) to locate where to insert the new section.

- [ ] **Step 2: Add the Python setup section**

Insert after the existing Node setup instructions:

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Python sidecar setup instructions"
```
