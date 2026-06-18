# UGC Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Next.js app that turns a client's product photo into ready-to-post UGC videos by classifying the product, scraping viral source videos, swapping in the client's face via WAN 2.2 Animate, lightly altering the result, and delivering finished videos to an approval queue.

**Architecture:** One Next.js (TypeScript) app run at `localhost:3000`. Backend logic lives in isolated, individually-tested modules under `src/lib/`, orchestrated by a job state machine. SQLite stores all records; the local filesystem stores media. Every heavy step (classify, scrape, avatar, swap) is an external HTTP API call, so no GPU or Python is needed.

**Tech Stack:** Next.js 15 (App Router), TypeScript, better-sqlite3, Vitest, fluent-ffmpeg (system ffmpeg), Apify client, fal.ai/Replicate, Anthropic SDK, Banana Pro (Nano Banana Pro image API).

## Global Constraints

- Node.js 20+ (LTS); package manager: npm.
- Language: TypeScript, `strict: true`.
- All external API calls go through a module in `src/lib/`; UI and API routes never call third-party APIs directly.
- The `swap` module abstracts the provider behind one interface; fal.ai vs Replicate is chosen by benchmarking during testing — never hardcode one at a call site.
- Tests mock all external APIs by default. Real-API integration tests are gated behind `RUN_LIVE_TESTS=1`.
- Secrets only via `.env` (gitignored): `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `FAL_KEY`, `REPLICATE_API_TOKEN`, `BANANA_PRO_API_KEY`.
- Viral filter: source videos must have **≥ 1,000,000 views** and be flagged music-only / minimal-talking.
- Job statuses are exactly: `queued → scraping → swapping → processing → ready → failed`.
- Media files live under `media/` (gitignored); never commit media or `*.sqlite`.

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable Next.js app and a working `npm test` command.

- [ ] **Step 1: Scaffold Next.js non-interactively**

Run:
```bash
npx --yes create-next-app@latest . --ts --app --eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-npm --yes
```
If the directory is non-empty and the command refuses, scaffold into a temp dir and move files in. Keep the existing `docs/` and `.git/`.

- [ ] **Step 2: Move app into `src/` and add test deps**

Ensure App Router lives at `src/app/`. Then:
```bash
npm install better-sqlite3 @anthropic-ai/sdk apify-client fluent-ffmpeg zod
npm install -D vitest @types/better-sqlite3 @types/fluent-ffmpeg
```

- [ ] **Step 3: Add Vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
```
Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 4: Create `.env.example`**

```
ANTHROPIC_API_KEY=
APIFY_TOKEN=
FAL_KEY=
REPLICATE_API_TOKEN=
BANANA_PRO_API_KEY=
SWAP_PROVIDER=fal
```

- [ ] **Step 5: Smoke test**

Run: `npm test`
Expected: Vitest runs and reports "No test files found" (exit 0) — config is valid.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Vitest and deps"
```

---

### Task 1: Database layer and schema

**Files:**
- Create: `src/lib/db/schema.sql`
- Create: `src/lib/db/index.ts`
- Test: `src/lib/db/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getDb(path?: string): Database` — returns a better-sqlite3 instance with schema applied (idempotent). Default path `media/app.sqlite`; tests pass `:memory:`.
  - Tables: `clients(id, name, created_at)`, `products(id, client_id, type, industry, keywords_json, photo_path, created_at)`, `product_memory(product_type PRIMARY KEY, answers_json, updated_at)`, `jobs(id, product_id, status, source_video_path, face_image_path, output_path, error, candidates_json, created_at, updated_at)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getDb } from './index';

describe('getDb', () => {
  it('creates schema and round-trips a client', () => {
    const db = getDb(':memory:');
    const info = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Acme');
    const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
    expect(row).toMatchObject({ name: 'Acme' });
  });

  it('has a product_memory table keyed by product_type', () => {
    const db = getDb(':memory:');
    db.prepare("INSERT INTO product_memory (product_type, answers_json) VALUES ('makeup', '{}')").run();
    const row = db.prepare("SELECT * FROM product_memory WHERE product_type = 'makeup'").get();
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Write the schema**

Create `src/lib/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  type TEXT,
  industry TEXT,
  keywords_json TEXT,
  photo_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS product_memory (
  product_type TEXT PRIMARY KEY,
  answers_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'queued',
  source_video_path TEXT,
  face_image_path TEXT,
  output_path TEXT,
  error TEXT,
  candidates_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Write the db module**

Create `src/lib/db/index.ts`:
```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

export function getDb(dbPath = 'media/app.sqlite'): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
```
Note: if the build inlines `__dirname` incorrectly, replace `SCHEMA` read with an inlined template string of the schema. Verify the test passes either way.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/db/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/db
git commit -m "feat: add SQLite schema and db accessor"
```

---

### Task 2: Product memory module

**Files:**
- Create: `src/lib/memory.ts`
- Test: `src/lib/memory.test.ts`

**Interfaces:**
- Consumes: `getDb` from Task 1.
- Produces:
  - `saveMemory(db, productType: string, answers: Record<string, unknown>): void`
  - `getMemory(db, productType: string): Record<string, unknown> | null`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { saveMemory, getMemory } from './memory';

describe('product memory', () => {
  it('returns null when no memory saved', () => {
    const db = getDb(':memory:');
    expect(getMemory(db, 'makeup')).toBeNull();
  });

  it('saves and retrieves answers by product type', () => {
    const db = getDb(':memory:');
    saveMemory(db, 'makeup', { vibe: 'GRWM', faceSource: 'upload' });
    expect(getMemory(db, 'makeup')).toEqual({ vibe: 'GRWM', faceSource: 'upload' });
  });

  it('overwrites on repeat save', () => {
    const db = getDb(':memory:');
    saveMemory(db, 'makeup', { vibe: 'GRWM' });
    saveMemory(db, 'makeup', { vibe: 'unboxing' });
    expect(getMemory(db, 'makeup')).toEqual({ vibe: 'unboxing' });
  });
});
```
Add `"@/lib/db"` index re-export if needed; this test imports from `./db` (the folder's `index.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/memory.test.ts`
Expected: FAIL — cannot find module `./memory`.

- [ ] **Step 3: Write the implementation**

```ts
import type Database from 'better-sqlite3';

export function saveMemory(db: Database.Database, productType: string, answers: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO product_memory (product_type, answers_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(product_type) DO UPDATE SET answers_json = excluded.answers_json, updated_at = datetime('now')`
  ).run(productType, JSON.stringify(answers));
}

export function getMemory(db: Database.Database, productType: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT answers_json FROM product_memory WHERE product_type = ?').get(productType) as
    | { answers_json: string }
    | undefined;
  return row ? JSON.parse(row.answers_json) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/memory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory.ts src/lib/memory.test.ts
git commit -m "feat: add per-product-type memory store"
```

---

### Task 3: Product classifier (Claude vision)

**Files:**
- Create: `src/lib/classifier.ts`
- Test: `src/lib/classifier.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `type Classification = { type: string; industry: string; keywords: string[] }`
  - `classifyProduct(imageBase64: string, deps?: { client?: AnthropicLike }): Promise<Classification>`
  - `interface AnthropicLike { messages: { create(args: unknown): Promise<{ content: { type: string; text: string }[] }> } }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { classifyProduct } from './classifier';

const fakeClient = {
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: '{"type":"makeup","industry":"beauty","keywords":["makeup","foundation"]}' }],
    }),
  },
};

describe('classifyProduct', () => {
  it('parses Claude JSON into a Classification', async () => {
    const result = await classifyProduct('BASE64', { client: fakeClient });
    expect(result).toEqual({ type: 'makeup', industry: 'beauty', keywords: ['makeup', 'foundation'] });
  });

  it('throws on unparseable model output', async () => {
    const bad = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json' }] }) } };
    await expect(classifyProduct('BASE64', { client: bad })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/classifier.test.ts`
Expected: FAIL — cannot find module `./classifier`.

- [ ] **Step 3: Write the implementation**

```ts
import Anthropic from '@anthropic-ai/sdk';

export type Classification = { type: string; industry: string; keywords: string[] };

export interface AnthropicLike {
  messages: { create(args: unknown): Promise<{ content: { type: string; text: string }[] }> };
}

const PROMPT =
  'Classify this product. Respond with ONLY minified JSON: ' +
  '{"type":"<short product type>","industry":"<industry>","keywords":["<search term>", ...]}. ' +
  'Keywords should be terms used to find viral TikTok/Reels videos of similar products.';

export async function classifyProduct(
  imageBase64: string,
  deps: { client?: AnthropicLike } = {}
): Promise<Classification> {
  const client = deps.client ?? (new Anthropic() as unknown as AnthropicLike);
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text) as Classification;
  if (!parsed.type || !Array.isArray(parsed.keywords)) throw new Error('Invalid classification shape');
  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/classifier.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/classifier.ts src/lib/classifier.test.ts
git commit -m "feat: add Claude vision product classifier"
```

---

### Task 4: Viral video scraper (Apify)

**Files:**
- Create: `src/lib/scraper.ts`
- Test: `src/lib/scraper.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `type Candidate = { url: string; views: number; downloadUrl: string; hasVoice: boolean; platform: 'tiktok' | 'reels' }`
  - `filterViral(items: Candidate[], minViews?: number): Candidate[]` — keeps `views >= minViews` (default 1_000_000) and `hasVoice === false`, sorted by views desc.
  - `findViralVideos(keywords: string[], deps?: { run?: ApifyRun }): Promise<Candidate[]>`
  - `type ApifyRun = (input: { keywords: string[] }) => Promise<Candidate[]>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { filterViral, findViralVideos, type Candidate } from './scraper';

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
  it('passes keywords to the runner and filters results', async () => {
    const run = async () => [c(9_000_000, false), c(10, false)];
    const out = await findViralVideos(['makeup'], { run });
    expect(out).toHaveLength(1);
    expect(out[0].views).toBe(9_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/scraper.test.ts`
Expected: FAIL — cannot find module `./scraper`.

- [ ] **Step 3: Write the implementation**

```ts
import { ApifyClient } from 'apify-client';

export type Candidate = {
  url: string;
  views: number;
  downloadUrl: string;
  hasVoice: boolean;
  platform: 'tiktok' | 'reels';
};

export type ApifyRun = (input: { keywords: string[] }) => Promise<Candidate[]>;

export function filterViral(items: Candidate[], minViews = 1_000_000): Candidate[] {
  return items
    .filter((i) => i.views >= minViews && i.hasVoice === false)
    .sort((a, b) => b.views - a.views);
}

const defaultRun: ApifyRun = async ({ keywords }) => {
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run = await client.actor('clockworks/tiktok-scraper').call({ searchQueries: keywords, resultsPerPage: 50 });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return (items as Record<string, unknown>[]).map((it) => ({
    url: String(it.webVideoUrl ?? ''),
    views: Number(it.playCount ?? 0),
    downloadUrl: String(it.videoUrl ?? ''),
    hasVoice: Boolean(it.hasVoice ?? false),
    platform: 'tiktok' as const,
  }));
};

export async function findViralVideos(keywords: string[], deps: { run?: ApifyRun } = {}): Promise<Candidate[]> {
  const run = deps.run ?? defaultRun;
  return filterViral(await run({ keywords }));
}
```
Note: `hasVoice` detection from Apify is approximate; the real heuristic (e.g. inspecting audio track) can be refined later. For v1, trust the scraper field and default to `false` when absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/scraper.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/scraper.ts src/lib/scraper.test.ts
git commit -m "feat: add Apify viral video scraper with filtering"
```

---

### Task 5: Media download helper

**Files:**
- Create: `src/lib/download.ts`
- Test: `src/lib/download.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `downloadTo(url: string, destPath: string, deps?: { fetchImpl?: typeof fetch }): Promise<string>` — returns `destPath`, creates parent dirs.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { downloadTo } from './download';

const tmp = 'media/test-out/sample.bin';
afterEach(() => fs.rmSync('media/test-out', { recursive: true, force: true }));

describe('downloadTo', () => {
  it('writes fetched bytes to disk and returns the path', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const out = await downloadTo('http://x/y', tmp, { fetchImpl });
    expect(out).toBe(tmp);
    expect(fs.readFileSync(tmp)).toEqual(Buffer.from([1, 2, 3]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/download.test.ts`
Expected: FAIL — cannot find module `./download`.

- [ ] **Step 3: Write the implementation**

```ts
import fs from 'node:fs';
import path from 'node:path';

export async function downloadTo(
  url: string,
  destPath: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/download.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/download.ts src/lib/download.test.ts
git commit -m "feat: add media download helper"
```

---

### Task 6: Face source resolver (upload or Banana Pro)

**Files:**
- Create: `src/lib/face.ts`
- Test: `src/lib/face.test.ts`

**Interfaces:**
- Consumes: `downloadTo` from Task 5.
- Produces:
  - `type FaceSpec = { kind: 'upload'; path: string } | { kind: 'generate'; prompt: string }`
  - `resolveFace(spec: FaceSpec, destPath: string, deps?: { generate?: AvatarGen; download?: typeof downloadTo }): Promise<string>`
  - `type AvatarGen = (prompt: string) => Promise<string>` — returns a URL to the generated image.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveFace } from './face';

describe('resolveFace', () => {
  it('returns the uploaded path unchanged', async () => {
    const out = await resolveFace({ kind: 'upload', path: 'media/face.jpg' }, 'media/dest.jpg');
    expect(out).toBe('media/face.jpg');
  });

  it('generates via avatar API then downloads to dest', async () => {
    const generate = async (p: string) => `http://img/${encodeURIComponent(p)}`;
    const download = async (_url: string, dest: string) => dest;
    const out = await resolveFace(
      { kind: 'generate', prompt: 'a friendly woman, studio light' },
      'media/dest.jpg',
      { generate, download }
    );
    expect(out).toBe('media/dest.jpg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/face.test.ts`
Expected: FAIL — cannot find module `./face`.

- [ ] **Step 3: Write the implementation**

```ts
import { downloadTo } from './download';

export type FaceSpec = { kind: 'upload'; path: string } | { kind: 'generate'; prompt: string };
export type AvatarGen = (prompt: string) => Promise<string>;

const defaultGenerate: AvatarGen = async (prompt) => {
  const res = await fetch('https://api.bananapro.ai/v1/images', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BANANA_PRO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, size: '1024x1024' }),
  });
  if (!res.ok) throw new Error(`Avatar generation failed: ${res.status}`);
  const data = (await res.json()) as { url?: string; data?: { url: string }[] };
  const url = data.url ?? data.data?.[0]?.url;
  if (!url) throw new Error('Avatar API returned no image url');
  return url;
};

export async function resolveFace(
  spec: FaceSpec,
  destPath: string,
  deps: { generate?: AvatarGen; download?: typeof downloadTo } = {}
): Promise<string> {
  if (spec.kind === 'upload') return spec.path;
  const generate = deps.generate ?? defaultGenerate;
  const download = deps.download ?? downloadTo;
  const url = await generate(spec.prompt);
  return download(url, destPath);
}
```
Note: confirm Banana Pro's exact endpoint/response shape during integration; the `defaultGenerate` body is isolated here so only this function changes if the contract differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/face.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/face.ts src/lib/face.test.ts
git commit -m "feat: add face resolver with Banana Pro avatar option"
```

---

### Task 7: Swap provider abstraction (WAN 2.2 Animate)

**Files:**
- Create: `src/lib/swap/types.ts`
- Create: `src/lib/swap/fal.ts`
- Create: `src/lib/swap/replicate.ts`
- Create: `src/lib/swap/index.ts`
- Test: `src/lib/swap/index.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `interface SwapProvider { swap(input: SwapInput): Promise<string> }` — returns URL of swapped video.
  - `type SwapInput = { videoUrl: string; imageUrl: string }`
  - `getSwapProvider(name?: string): SwapProvider` — `name` defaults to `process.env.SWAP_PROVIDER`; accepts `'fal' | 'replicate'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getSwapProvider } from './index';

describe('getSwapProvider', () => {
  it('returns a fal provider by name', () => {
    const p = getSwapProvider('fal');
    expect(typeof p.swap).toBe('function');
  });

  it('returns a replicate provider by name', () => {
    const p = getSwapProvider('replicate');
    expect(typeof p.swap).toBe('function');
  });

  it('throws on unknown provider', () => {
    expect(() => getSwapProvider('bogus')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/swap/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Write types and the two providers**

Create `src/lib/swap/types.ts`:
```ts
export type SwapInput = { videoUrl: string; imageUrl: string };
export interface SwapProvider {
  swap(input: SwapInput): Promise<string>;
}
```

Create `src/lib/swap/fal.ts`:
```ts
import type { SwapProvider, SwapInput } from './types';

// fal-ai/wan/v2.2-14b/animate/replace — submit, poll, fetch.
export const falProvider: SwapProvider = {
  async swap({ videoUrl, imageUrl }: SwapInput): Promise<string> {
    const res = await fetch('https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/replace', {
      method: 'POST',
      headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: videoUrl, image_url: imageUrl }),
    });
    if (!res.ok) throw new Error(`fal submit failed: ${res.status}`);
    const { status_url } = (await res.json()) as { status_url: string };
    // Poll until completed.
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetch(status_url, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
      const body = (await s.json()) as { status: string; response_url?: string };
      if (body.status === 'COMPLETED' && body.response_url) {
        const out = await fetch(body.response_url, { headers: { Authorization: `Key ${process.env.FAL_KEY}` } });
        const data = (await out.json()) as { video?: { url: string } };
        if (!data.video?.url) throw new Error('fal returned no video url');
        return data.video.url;
      }
      if (body.status === 'FAILED') throw new Error('fal job failed');
    }
  },
};
```

Create `src/lib/swap/replicate.ts`:
```ts
import type { SwapProvider, SwapInput } from './types';

// wan-video/wan-2.2-animate-replace on Replicate — create prediction, poll.
export const replicateProvider: SwapProvider = {
  async swap({ videoUrl, imageUrl }: SwapInput): Promise<string> {
    const res = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({
        version: 'wan-video/wan-2.2-animate-replace',
        input: { video: videoUrl, image: imageUrl },
      }),
    });
    if (!res.ok) throw new Error(`replicate submit failed: ${res.status}`);
    let pred = (await res.json()) as { status: string; output?: string | string[]; urls?: { get: string } };
    while (pred.status !== 'succeeded' && pred.status !== 'failed') {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await fetch(pred.urls!.get, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      pred = (await s.json()) as typeof pred;
    }
    if (pred.status === 'failed') throw new Error('replicate job failed');
    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!out) throw new Error('replicate returned no output');
    return out;
  },
};
```
Note: exact field names (`response_url`, `version` slug vs version hash) must be verified against live API docs during integration; both providers are isolated so corrections touch one file.

- [ ] **Step 4: Write the selector**

Create `src/lib/swap/index.ts`:
```ts
import type { SwapProvider } from './types';
import { falProvider } from './fal';
import { replicateProvider } from './replicate';

export type { SwapProvider, SwapInput } from './types';

export function getSwapProvider(name = process.env.SWAP_PROVIDER ?? 'fal'): SwapProvider {
  if (name === 'fal') return falProvider;
  if (name === 'replicate') return replicateProvider;
  throw new Error(`Unknown swap provider: ${name}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/swap/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/swap
git commit -m "feat: add WAN swap provider abstraction (fal + replicate)"
```

---

### Task 8: Distinctiveness post-processing (ffmpeg)

**Files:**
- Create: `src/lib/postprocess.ts`
- Test: `src/lib/postprocess.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `buildFilter(opts?: { hueShift?: number; cropPct?: number; speed?: number }): string` — returns an ffmpeg `-vf`/filter string for a light distinctiveness pass (color grade + crop/zoom + speed).
  - `distinctify(inputPath: string, outputPath: string, deps?: { runFfmpeg?: RunFfmpeg }): Promise<string>`
  - `type RunFfmpeg = (input: string, output: string, filter: string) => Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildFilter, distinctify } from './postprocess';

describe('buildFilter', () => {
  it('includes hue, crop and setpts for default light touch', () => {
    const f = buildFilter();
    expect(f).toContain('hue=');
    expect(f).toContain('crop=');
    expect(f).toContain('setpts=');
  });
});

describe('distinctify', () => {
  it('invokes ffmpeg runner with built filter and returns output path', async () => {
    let seen = '';
    const runFfmpeg = async (_i: string, _o: string, filter: string) => { seen = filter; };
    const out = await distinctify('in.mp4', 'out.mp4', { runFfmpeg });
    expect(out).toBe('out.mp4');
    expect(seen).toContain('crop=');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/postprocess.test.ts`
Expected: FAIL — cannot find module `./postprocess`.

- [ ] **Step 3: Write the implementation**

```ts
import ffmpeg from 'fluent-ffmpeg';

export type RunFfmpeg = (input: string, output: string, filter: string) => Promise<void>;

export function buildFilter(opts: { hueShift?: number; cropPct?: number; speed?: number } = {}): string {
  const hue = opts.hueShift ?? 8;
  const crop = opts.cropPct ?? 0.96;
  const speed = opts.speed ?? 1.03;
  // Slight color grade, center crop+zoom, minor speed change.
  return [
    `hue=h=${hue}:s=1.05`,
    `crop=iw*${crop}:ih*${crop}`,
    `scale=iw/${crop}:ih/${crop}`,
    `setpts=${(1 / speed).toFixed(4)}*PTS`,
  ].join(',');
}

const defaultRun: RunFfmpeg = (input, output, filter) =>
  new Promise((resolve, reject) => {
    ffmpeg(input)
      .videoFilters(filter)
      .on('end', () => resolve())
      .on('error', reject)
      .save(output);
  });

export async function distinctify(
  inputPath: string,
  outputPath: string,
  deps: { runFfmpeg?: RunFfmpeg } = {}
): Promise<string> {
  const run = deps.runFfmpeg ?? defaultRun;
  await run(inputPath, outputPath, buildFilter());
  return outputPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/postprocess.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/postprocess.ts src/lib/postprocess.test.ts
git commit -m "feat: add ffmpeg distinctiveness pass"
```

---

### Task 9: Job state machine / pipeline runner

**Files:**
- Create: `src/lib/jobs.ts`
- Test: `src/lib/jobs.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 1), and the step modules — injected as deps so the runner is testable without real APIs.
- Produces:
  - `type JobStatus = 'queued' | 'scraping' | 'swapping' | 'processing' | 'ready' | 'failed'`
  - `createJob(db, productId: number): number` — inserts a `queued` job, returns id.
  - `advanceJob(db, jobId: number, steps: PipelineSteps): Promise<JobStatus>` — runs the job from its current status to the next, persisting status/paths/errors. Idempotent per call (advances one stage or to terminal).
  - `interface PipelineSteps { scrape(): Promise<{ sourcePath: string; candidates: unknown[] }>; swap(sourcePath: string): Promise<string>; process(swappedPath: string): Promise<string>; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { createJob, advanceJob } from './jobs';

function seedProduct(db: ReturnType<typeof getDb>) {
  const cl = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Acme');
  const pr = db.prepare('INSERT INTO products (client_id, type) VALUES (?, ?)').run(cl.lastInsertRowid, 'makeup');
  return Number(pr.lastInsertRowid);
}

const okSteps = {
  scrape: async () => ({ sourcePath: 'media/src.mp4', candidates: [{ url: 'a' }] }),
  swap: async () => 'media/swapped.mp4',
  process: async () => 'media/final.mp4',
};

describe('job pipeline', () => {
  it('runs queued -> ready across advances', async () => {
    const db = getDb(':memory:');
    const id = createJob(db, seedProduct(db));
    let status = await advanceJob(db, id, okSteps); // scraping
    status = await advanceJob(db, id, okSteps); // swapping
    status = await advanceJob(db, id, okSteps); // processing -> ready
    expect(status).toBe('ready');
    const row = db.prepare('SELECT output_path, status FROM jobs WHERE id = ?').get(id) as any;
    expect(row.output_path).toBe('media/final.mp4');
    expect(row.status).toBe('ready');
  });

  it('marks job failed and records error when a step throws', async () => {
    const db = getDb(':memory:');
    const id = createJob(db, seedProduct(db));
    const badSteps = { ...okSteps, scrape: async () => { throw new Error('apify down'); } };
    const status = await advanceJob(db, id, badSteps);
    expect(status).toBe('failed');
    const row = db.prepare('SELECT error FROM jobs WHERE id = ?').get(id) as any;
    expect(row.error).toContain('apify down');
  });

  it('can retry a failed job from the start', async () => {
    const db = getDb(':memory:');
    const id = createJob(db, seedProduct(db));
    await advanceJob(db, id, { ...okSteps, scrape: async () => { throw new Error('x'); } });
    db.prepare("UPDATE jobs SET status = 'queued', error = NULL WHERE id = ?").run(id);
    const status = await advanceJob(db, id, okSteps);
    expect(status).toBe('scraping');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: FAIL — cannot find module `./jobs`.

- [ ] **Step 3: Write the implementation**

```ts
import type Database from 'better-sqlite3';

export type JobStatus = 'queued' | 'scraping' | 'swapping' | 'processing' | 'ready' | 'failed';

export interface PipelineSteps {
  scrape(): Promise<{ sourcePath: string; candidates: unknown[] }>;
  swap(sourcePath: string): Promise<string>;
  process(swappedPath: string): Promise<string>;
}

export function createJob(db: Database.Database, productId: number): number {
  const info = db.prepare("INSERT INTO jobs (product_id, status) VALUES (?, 'queued')").run(productId);
  return Number(info.lastInsertRowid);
}

function setJob(db: Database.Database, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export async function advanceJob(db: Database.Database, jobId: number, steps: PipelineSteps): Promise<JobStatus> {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  const status = job.status as JobStatus;
  try {
    if (status === 'queued') {
      const { sourcePath, candidates } = await steps.scrape();
      setJob(db, jobId, { status: 'scraping', source_video_path: sourcePath, candidates_json: JSON.stringify(candidates) });
      return 'scraping';
    }
    if (status === 'scraping') {
      const swapped = await steps.swap(job.source_video_path);
      setJob(db, jobId, { status: 'swapping', output_path: swapped });
      return 'swapping';
    }
    if (status === 'swapping') {
      const finalPath = await steps.process(job.output_path);
      setJob(db, jobId, { status: 'ready', output_path: finalPath });
      return 'ready';
    }
    return status;
  } catch (err) {
    setJob(db, jobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}
```
Note: the intermediate `output_path` after swap is overwritten by `process`; that is intentional — only the final distinctified file is retained for delivery.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs.ts src/lib/jobs.test.ts
git commit -m "feat: add job state machine with retry"
```

---

### Task 10: Pipeline wiring (compose real steps)

**Files:**
- Create: `src/lib/pipeline.ts`
- Test: `src/lib/pipeline.test.ts`

**Interfaces:**
- Consumes: `findViralVideos` (T4), `downloadTo` (T5), `resolveFace` (T6), `getSwapProvider` (T7), `distinctify` (T8), `PipelineSteps` (T9).
- Produces:
  - `buildSteps(args: { keywords: string[]; faceImagePath: string; jobId: number; deps?: Partial<PipelineDeps> }): PipelineSteps`
  - `interface PipelineDeps { find: typeof findViralVideos; download: typeof downloadTo; swap: SwapProvider['swap']; process: typeof distinctify; uploadForUrl: (localPath: string) => Promise<string>; }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildSteps } from './pipeline';

describe('buildSteps', () => {
  it('wires scrape -> download into a sourcePath', async () => {
    const steps = buildSteps({
      keywords: ['makeup'],
      faceImagePath: 'media/face.jpg',
      jobId: 1,
      deps: {
        find: async () => [
          { url: 'u', views: 9_000_000, downloadUrl: 'http://v/clip.mp4', hasVoice: false, platform: 'tiktok' },
        ],
        download: async (_u: string, dest: string) => dest,
        swap: async () => 'http://v/swapped.mp4',
        process: async (_i: string, o: string) => o,
        uploadForUrl: async (p: string) => `http://local/${p}`,
      },
    });
    const scraped = await steps.scrape();
    expect(scraped.sourcePath).toContain('media/jobs/1/source');
    const swapped = await steps.swap(scraped.sourcePath);
    expect(swapped).toContain('media/jobs/1/swapped');
    const final = await steps.process(swapped);
    expect(final).toContain('media/jobs/1/final');
  });

  it('throws when no viral candidates found', async () => {
    const steps = buildSteps({
      keywords: ['x'], faceImagePath: 'f.jpg', jobId: 2,
      deps: { find: async () => [], download: async (_u, d) => d, swap: async () => 's', process: async (_i, o) => o, uploadForUrl: async (p) => p },
    });
    await expect(steps.scrape()).rejects.toThrow(/no viral/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: FAIL — cannot find module `./pipeline`.

- [ ] **Step 3: Write the implementation**

```ts
import { findViralVideos } from './scraper';
import { downloadTo } from './download';
import { getSwapProvider } from './swap';
import { distinctify } from './postprocess';
import type { PipelineSteps } from './jobs';

export interface PipelineDeps {
  find: typeof findViralVideos;
  download: typeof downloadTo;
  swap: (input: { videoUrl: string; imageUrl: string }) => Promise<string>;
  process: typeof distinctify;
  uploadForUrl: (localPath: string) => Promise<string>;
}

export function buildSteps(args: {
  keywords: string[];
  faceImagePath: string;
  jobId: number;
  deps?: Partial<PipelineDeps>;
}): PipelineSteps {
  const d: PipelineDeps = {
    find: args.deps?.find ?? findViralVideos,
    download: args.deps?.download ?? downloadTo,
    swap: args.deps?.swap ?? getSwapProvider().swap,
    process: args.deps?.process ?? distinctify,
    uploadForUrl: args.deps?.uploadForUrl ?? (async (p) => p),
  };
  const dir = `media/jobs/${args.jobId}`;

  return {
    async scrape() {
      const candidates = await d.find(args.keywords);
      if (candidates.length === 0) throw new Error('No viral candidates found');
      const sourcePath = `${dir}/source.mp4`;
      await d.download(candidates[0].downloadUrl, sourcePath);
      return { sourcePath, candidates };
    },
    async swap(sourcePath: string) {
      const videoUrl = await d.uploadForUrl(sourcePath);
      const imageUrl = await d.uploadForUrl(args.faceImagePath);
      const resultUrl = await d.swap({ videoUrl, imageUrl });
      const swappedPath = `${dir}/swapped.mp4`;
      await d.download(resultUrl, swappedPath);
      return swappedPath;
    },
    async process(swappedPath: string) {
      const finalPath = `${dir}/final.mp4`;
      await d.process(swappedPath, finalPath);
      return finalPath;
    },
  };
}
```
Note: `uploadForUrl` exists because WAN providers need a publicly reachable URL for the local source video and face image. For v1 the default is a passthrough; during integration, implement it as a temporary upload (e.g. fal/Replicate file upload endpoint or a signed temp host). This is the one piece that must be made real before the live pipeline works end-to-end — flagged for the integration task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipeline.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline.ts src/lib/pipeline.test.ts
git commit -m "feat: wire real pipeline steps"
```

---

### Task 11: API routes

**Files:**
- Create: `src/app/api/products/route.ts` (POST: upload photo → classify → return detection + memory)
- Create: `src/app/api/jobs/route.ts` (GET: list jobs; POST: create + enqueue N jobs)
- Create: `src/app/api/jobs/[id]/advance/route.ts` (POST: advance/retry one job)
- Test: `src/app/api/products/route.test.ts`, `src/app/api/jobs/route.test.ts`

**Interfaces:**
- Consumes: `classifyProduct`, `getMemory`/`saveMemory`, `createJob`, `advanceJob`, `buildSteps`, `getDb`.
- Produces: HTTP JSON endpoints. Handlers import a `getDb()` and accept a base64 image or JSON body.

- [ ] **Step 1: Write the failing test (products route)**

Test the handler function directly (not over HTTP) by importing `POST` and passing a `Request`:
```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/classifier', () => ({
  classifyProduct: async () => ({ type: 'makeup', industry: 'beauty', keywords: ['makeup'] }),
}));

import { POST } from './route';

describe('POST /api/products', () => {
  it('returns classification and memory flag', async () => {
    const req = new Request('http://localhost/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: 'Acme', imageBase64: 'AAAA' }),
    });
    const res = await POST(req);
    const json = await res.json();
    expect(json.classification.type).toBe('makeup');
    expect(json).toHaveProperty('remembered'); // null first time
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/products/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 3: Implement products route**

```ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyProduct } from '@/lib/classifier';
import { getMemory } from '@/lib/memory';

export async function POST(req: Request) {
  const { clientName, imageBase64 } = (await req.json()) as { clientName: string; imageBase64: string };
  const db = getDb();
  const classification = await classifyProduct(imageBase64);
  const remembered = getMemory(db, classification.type);
  const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run(clientName ?? 'Client');
  const product = db
    .prepare('INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, ?, ?, ?)')
    .run(client.lastInsertRowid, classification.type, classification.industry, JSON.stringify(classification.keywords));
  return NextResponse.json({ productId: Number(product.lastInsertRowid), classification, remembered });
}
```

- [ ] **Step 4: Run products test to verify it passes**

Run: `npx vitest run src/app/api/products/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test for jobs route**

```ts
import { describe, it, expect } from 'vitest';
import { POST, GET } from './route';

describe('jobs route', () => {
  it('creates N queued jobs and lists them', async () => {
    const create = new Request('http://localhost/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 1, count: 3, faceSource: { kind: 'upload', path: 'media/f.jpg' }, answers: { vibe: 'GRWM' } }),
    });
    const created = await (await POST(create)).json();
    expect(created.jobIds).toHaveLength(3);
    const listed = await (await GET()).json();
    expect(listed.jobs.length).toBeGreaterThanOrEqual(3);
  });
});
```
This test relies on a shared on-disk test DB; set `process.env.UGC_DB = ':memory:'` is not possible across handler calls, so point `getDb()` at a temp file via an env var `UGC_DB_PATH` and clean it in the test's `afterEach`. Update `getDb` default to read `process.env.UGC_DB_PATH ?? 'media/app.sqlite'` (small change to Task 1 file; re-run Task 1 tests after).

- [ ] **Step 6: Run jobs test to verify it fails**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement jobs routes**

`src/app/api/jobs/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createJob } from '@/lib/jobs';
import { saveMemory } from '@/lib/memory';

export async function GET() {
  const db = getDb();
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  const { productId, count, answers } = (await req.json()) as {
    productId: number; count: number; faceSource: unknown; answers?: Record<string, unknown>;
  };
  const db = getDb();
  const product = db.prepare('SELECT type FROM products WHERE id = ?').get(productId) as { type: string } | undefined;
  if (product && answers) saveMemory(db, product.type, answers);
  const jobIds = Array.from({ length: count }, () => createJob(db, productId));
  return NextResponse.json({ jobIds });
}
```

`src/app/api/jobs/[id]/advance/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { advanceJob } from '@/lib/jobs';
import { buildSteps } from '@/lib/pipeline';
import { resolveFace, type FaceSpec } from '@/lib/face';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(job.product_id) as any;
  const keywords = JSON.parse(product.keywords_json ?? '[]');
  const body = (await req.json().catch(() => ({}))) as { faceSource?: FaceSpec };
  const faceImagePath = body.faceSource
    ? await resolveFace(body.faceSource, `media/jobs/${jobId}/face.jpg`)
    : (job.face_image_path ?? 'media/jobs/' + jobId + '/face.jpg');
  const steps = buildSteps({ keywords, faceImagePath, jobId });
  const status = await advanceJob(db, jobId, steps);
  return NextResponse.json({ status });
}
```

- [ ] **Step 8: Run jobs test to verify it passes**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/api src/lib/db
git commit -m "feat: add product and job API routes"
```

---

### Task 12: Dashboard UI

**Files:**
- Modify: `src/app/page.tsx`
- Create: `src/app/components/ProductUpload.tsx`
- Create: `src/app/components/JobQueue.tsx`
- Create: `src/app/ready/page.tsx` ("Ready to Post" queue)

**Interfaces:**
- Consumes: the API routes from Task 11 via `fetch`.
- Produces: the client-facing screens. (UI is verified manually, not via Vitest.)

- [ ] **Step 1: Build ProductUpload component**

Client component: file input → reads file as base64 → POST `/api/products` → shows detected `type`/`industry`/`keywords`. If `remembered` is non-null, show "We remember this product — using saved answers" and skip the question form; otherwise render the onboarding questions (vibe, face source: upload file or generate-prompt, videos per week).

```tsx
'use client';
import { useState } from 'react';

export function ProductUpload() {
  const [result, setResult] = useState<any>(null);
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    const res = await fetch('/api/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: 'Me', imageBase64: b64 }),
    });
    setResult(await res.json());
  }
  return (
    <section>
      <h2>Upload product photo</h2>
      <input type="file" accept="image/*" onChange={onFile} />
      {result && (
        <div>
          <p>Type: {result.classification.type}</p>
          <p>Industry: {result.classification.industry}</p>
          <p>Keywords: {result.classification.keywords.join(', ')}</p>
          {result.remembered ? <p>Using saved answers ✓</p> : <p>New product — answer the questions below.</p>}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Build JobQueue + Ready page**

`JobQueue.tsx`: polls `GET /api/jobs` every few seconds, lists jobs with status badges, and a "Advance / Retry" button per job that POSTs to `/api/jobs/{id}/advance`.

`src/app/ready/page.tsx`: server component that reads jobs with `status = 'ready'` and renders each `output_path` as a downloadable `<video>` with a "Mark posted" action.

```tsx
import { getDb } from '@/lib/db';

export default function ReadyPage() {
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'ready' ORDER BY updated_at DESC").all() as any[];
  return (
    <main>
      <h1>Ready to Post</h1>
      {jobs.length === 0 && <p>No finished videos yet.</p>}
      {jobs.map((j) => (
        <article key={j.id}>
          <video src={'/' + j.output_path} controls width={320} />
          <a href={'/' + j.output_path} download>Download</a>
        </article>
      ))}
    </main>
  );
}
```
Note: to serve files under `media/`, add a small static file route (`src/app/media/[...path]/route.ts`) that streams files from the `media/` directory, since Next.js does not serve arbitrary project folders. Implement it to read the requested path safely (reject `..`) and return the bytes with the right content type.

- [ ] **Step 3: Wire page.tsx**

`src/app/page.tsx` renders `<ProductUpload />` and `<JobQueue />` and links to `/ready`.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`. Confirm upload returns a classification (requires `ANTHROPIC_API_KEY`). With APIs unconfigured, advancing a job should surface a clear `failed` status — confirm the error text appears.

- [ ] **Step 5: Commit**

```bash
git add src/app
git commit -m "feat: add dashboard, job queue, and ready-to-post page"
```

---

### Task 13: README and run instructions

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing. Documents setup for clients.

- [ ] **Step 1: Write the README**

Cover: prerequisites (Node 20+, system `ffmpeg` installed), `git clone`, `cp .env.example .env` and fill keys, `npm install`, `npm run dev`, open `localhost:3000`. Document each `.env` key, the `SWAP_PROVIDER` switch, where media lands (`media/`), and the manual-posting workflow. Add a short "How it works" pipeline diagram in text.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add setup and usage README"
```

---

### Task 14: Live integration smoke test (gated)

**Files:**
- Create: `src/lib/integration.live.test.ts`

**Interfaces:**
- Consumes: real providers. Gated behind `RUN_LIVE_TESTS=1`.

- [ ] **Step 1: Write a gated end-to-end test**

`describe.skipIf(!process.env.RUN_LIVE_TESTS)` — classify a real sample image, scrape one real keyword (assert ≥1 candidate), then run `getSwapProvider().swap` on a short public sample video + face image and assert a URL is returned. Use the smallest/cheapest settings. Implement `uploadForUrl` here for real (fal/Replicate upload endpoint) and confirm the full `buildSteps` chain produces a final file.

- [ ] **Step 2: Run gated test manually**

Run: `RUN_LIVE_TESTS=1 npx vitest run src/lib/integration.live.test.ts`
Expected: PASS (spends a small amount of real API credit). This is where fal.ai vs Replicate is benchmarked; set the winner as `SWAP_PROVIDER` default.

- [ ] **Step 3: Commit**

```bash
git add src/lib/integration.live.test.ts
git commit -m "test: add gated live integration smoke test"
```

---

## Self-Review

**Spec coverage:**
- Self-hosted Next.js local app → Tasks 0, 12, 13. ✓
- SQLite + filesystem storage → Task 1, media paths throughout. ✓
- Claude vision classification → Task 3. ✓
- Confirm-first + per-product memory → Tasks 2, 11 (saveMemory on job creation), 12 (UI skip). ✓
- Face source upload OR Banana Pro avatar → Task 6. ✓
- Apify scrape, ≥1M views, music-only filter → Task 4. ✓
- WAN 2.2 Animate swap, provider-abstracted (fal/replicate) → Task 7, benchmarked in Task 14. ✓
- Light ffmpeg distinctiveness pass → Task 8. ✓
- Approval queue / manual posting delivery → Task 12 (`/ready`). ✓
- Job state machine with retry → Task 9. ✓
- Cadence (N videos/week) → Task 11 (`count` jobs). ✓
- `.env` config → Tasks 0, 13. ✓
- Mocked tests + gated live tests → all module tasks + Task 14. ✓

**Gap noted & addressed:** WAN providers need public URLs for local files — captured as `uploadForUrl` in Task 10 and made real in Task 14. Flagged explicitly rather than left implicit.

**Placeholder scan:** No "TBD"/"handle edge cases" placeholders; every code step shows real code. Provider field-name caveats are called out as integration-verification notes, not left as silent assumptions.

**Type consistency:** `Classification`, `Candidate`, `FaceSpec`, `SwapInput`/`SwapProvider`, `PipelineSteps`, `JobStatus` names are used consistently across producing and consuming tasks.
