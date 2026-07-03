# Job/Avatar UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3-option avatar picker with a reusable saved avatar, prevent
accidental double-submits, and add job renaming, manual deletion, and
automatic failed-job cleanup.

**Architecture:** A new singleton `avatar` DB table plus a `media/avatar.jpg`
file hold the one reusable avatar; a new `src/lib/avatar.ts` module owns its
CRUD, thin API routes wrap it. `jobs.ts` gains rename/delete/sweep functions
with thin API routes wrapping those. `ProductUpload.tsx` and `JobQueue.tsx`
get UI changes consuming these new endpoints.

**Tech Stack:** Next.js App Router API routes, better-sqlite3, vitest (with
`vi.mock` for external-API-calling modules, matching `route.test.ts`'s
existing pattern), React (client components, matching existing style).

## Global Constraints

- One global saved avatar (not per-client/per-product).
- Saved avatar can be regenerated later via an explicit action, not locked
  in permanently.
- After a successful job submission, the form disappears entirely, replaced
  by a "Start another job" button.
- Failed jobs show their error with a manual "Dismiss" button, and are also
  automatically swept if left failed for over an hour.
- `scraper.ts`/`pipeline.ts`/job status machine are NOT touched by this plan
  — the existing `generating_face` status is left as dead code for the new
  flow, not removed.
- 3 avatar options generated per attempt (fixed, not configurable).
- Auto-sweep window is a fixed 1 hour (not configurable).

---

### Task 1: DB schema — avatar table + jobs.name column

**Files:**
- Modify: `src/lib/db/schema.sql`
- Modify: `src/lib/db/index.ts`
- Test: `src/lib/db/index.test.ts` (check if this file exists first; if not,
  add the new tests to the end of it, creating it only with these tests)

**Interfaces:**
- Produces: `avatar` table (`id INTEGER PRIMARY KEY CHECK (id = 1),
  image_path TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT
  (datetime('now'))`); `jobs.name TEXT` column.

- [ ] **Step 1: Write the failing test**

Check whether `src/lib/db/index.test.ts` already exists and read it first —
append to it if so, matching its existing style. If it doesn't exist, create
it with this content:

```typescript
import { describe, it, expect } from 'vitest';
import { getDb } from './index';

describe('schema migrations', () => {
  it('creates the avatar table', () => {
    const db = getDb(':memory:');
    db.prepare("INSERT INTO avatar (id, image_path) VALUES (1, 'media/avatar.jpg')").run();
    const row = db.prepare('SELECT image_path FROM avatar WHERE id = 1').get() as any;
    expect(row.image_path).toBe('media/avatar.jpg');
  });

  it('adds a name column to jobs', () => {
    const db = getDb(':memory:');
    const cl = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Test');
    const pr = db.prepare('INSERT INTO products (client_id, type) VALUES (?, ?)').run(cl.lastInsertRowid, 'skincare');
    const job = db.prepare('INSERT INTO jobs (product_id, name) VALUES (?, ?)').run(pr.lastInsertRowid, 'My Job');
    const row = db.prepare('SELECT name FROM jobs WHERE id = ?').get(job.lastInsertRowid) as any;
    expect(row.name).toBe('My Job');
  });
});
```

If appending to an existing file, add only the two `it(...)` blocks inside a
new `describe('avatar + job name migrations', ...)` block instead of
duplicating the whole file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/index.test.ts`
Expected: FAIL — `no such table: avatar` / `no such column: name`

- [ ] **Step 3: Add the schema + migration**

In `src/lib/db/schema.sql`, add at the end:

```sql
CREATE TABLE IF NOT EXISTS avatar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  image_path TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

In `src/lib/db/index.ts`, inside the `migrate` function, add one line next
to the other `hasJob(...)` checks:

```typescript
  if (!hasJob('name')) db.exec('ALTER TABLE jobs ADD COLUMN name TEXT');
```

(`CREATE TABLE IF NOT EXISTS` in schema.sql already handles the `avatar`
table for both new and existing databases — no separate migration needed
for it, since it's a wholly new table rather than a new column on an
existing table.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/index.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.sql src/lib/db/index.ts src/lib/db/index.test.ts
git commit -m "feat: add avatar table and jobs.name column"
```

---

### Task 2: `face.ts` — generate multiple avatar options

**Files:**
- Modify: `src/lib/face.ts`
- Test: `src/lib/face.test.ts`

**Interfaces:**
- Consumes: `AvatarGen` (existing type), `downloadTo` (existing).
- Produces: `generateAvatarOptions(prompt: string, count: number, destDir:
  string, deps?: { generate?: AvatarGen; download?: typeof downloadTo }):
  Promise<string[]>` — returns `count` local file paths
  `${destDir}/option-0.jpg`, `${destDir}/option-1.jpg`, etc.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/lib/face.test.ts
import { generateAvatarOptions } from './face';

describe('generateAvatarOptions', () => {
  it('generates and downloads `count` distinct avatar options', async () => {
    let generateCalls = 0;
    const generate = async (_prompt: string) => {
      generateCalls += 1;
      return `http://img/${generateCalls}`;
    };
    const downloaded: Array<[string, string]> = [];
    const download = async (url: string, dest: string) => {
      downloaded.push([url, dest]);
      return dest;
    };
    const paths = await generateAvatarOptions('a friendly woman', 3, 'media/avatar-options', { generate, download });
    expect(generateCalls).toBe(3);
    expect(paths).toEqual([
      'media/avatar-options/option-0.jpg',
      'media/avatar-options/option-1.jpg',
      'media/avatar-options/option-2.jpg',
    ]);
    expect(downloaded).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/face.test.ts`
Expected: FAIL with "generateAvatarOptions is not a function" or similar

- [ ] **Step 3: Write the implementation**

Append to `src/lib/face.ts`:

```typescript
/**
 * Generates `count` avatar options from the same prompt so the caller can
 * pick one to save and reuse, instead of committing to a single generation.
 */
export async function generateAvatarOptions(
  prompt: string,
  count: number,
  destDir: string,
  deps: { generate?: AvatarGen; download?: typeof downloadTo } = {}
): Promise<string[]> {
  const generate = deps.generate ?? defaultGenerate;
  const download = deps.download ?? downloadTo;
  const urls = await Promise.all(Array.from({ length: count }, () => generate(prompt)));
  return Promise.all(urls.map((url, i) => download(url, `${destDir}/option-${i}.jpg`)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/face.test.ts`
Expected: PASS (3 tests total: the 2 existing `resolveFace` tests + the new one)

- [ ] **Step 5: Commit**

```bash
git add src/lib/face.ts src/lib/face.test.ts
git commit -m "feat: add generateAvatarOptions for the avatar picker"
```

---

### Task 3: `src/lib/avatar.ts` — saved avatar CRUD

**Files:**
- Create: `src/lib/avatar.ts`
- Test: `src/lib/avatar.test.ts`

**Interfaces:**
- Consumes: `Database.Database` (better-sqlite3, matching `jobs.ts`'s
  pattern).
- Produces: `getSavedAvatarPath(db: Database.Database): string | null`,
  `saveAvatarChoice(db: Database.Database, chosenPath: string, deps?: {
  copyFile?: typeof fs.copyFileSync }): string` (returns `'media/avatar.jpg'`
  always), `clearSavedAvatar(db: Database.Database, deps?: { rm?: typeof
  fs.rmSync }): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/avatar.test.ts
import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { getSavedAvatarPath, saveAvatarChoice, clearSavedAvatar } from './avatar';

describe('avatar', () => {
  it('returns null when no avatar has been saved', () => {
    const db = getDb(':memory:');
    expect(getSavedAvatarPath(db)).toBeNull();
  });

  it('saves a chosen avatar, copying it to media/avatar.jpg and recording it', () => {
    const db = getDb(':memory:');
    const copied: Array<[string, string]> = [];
    const copyFile = (src: string, dest: string) => { copied.push([src, dest]); };
    const result = saveAvatarChoice(db, 'media/avatar-options/option-1.jpg', { copyFile });
    expect(result).toBe('media/avatar.jpg');
    expect(copied).toEqual([['media/avatar-options/option-1.jpg', 'media/avatar.jpg']]);
    expect(getSavedAvatarPath(db)).toBe('media/avatar.jpg');
  });

  it('replaces a previously saved avatar rather than erroring on a second save', () => {
    const db = getDb(':memory:');
    const copyFile = () => {};
    saveAvatarChoice(db, 'media/avatar-options/option-0.jpg', { copyFile });
    saveAvatarChoice(db, 'media/avatar-options/option-2.jpg', { copyFile });
    expect(getSavedAvatarPath(db)).toBe('media/avatar.jpg');
    const count = db.prepare('SELECT COUNT(*) as c FROM avatar').get() as any;
    expect(count.c).toBe(1);
  });

  it('clears the saved avatar', () => {
    const db = getDb(':memory:');
    const copyFile = () => {};
    saveAvatarChoice(db, 'media/avatar-options/option-0.jpg', { copyFile });
    const rm = () => {};
    clearSavedAvatar(db, { rm });
    expect(getSavedAvatarPath(db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/avatar.test.ts`
Expected: FAIL — `Cannot find module './avatar'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/avatar.ts
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const AVATAR_PATH = 'media/avatar.jpg';

/** Returns the currently saved avatar's path, or null if none has been chosen yet. */
export function getSavedAvatarPath(db: Database.Database): string | null {
  const row = db.prepare('SELECT image_path FROM avatar WHERE id = 1').get() as
    | { image_path: string }
    | undefined;
  return row?.image_path ?? null;
}

/** Copies the chosen avatar option to the fixed saved-avatar path and records it, replacing any prior choice. */
export function saveAvatarChoice(
  db: Database.Database,
  chosenPath: string,
  deps: { copyFile?: typeof fs.copyFileSync } = {}
): string {
  const copyFile = deps.copyFile ?? fs.copyFileSync;
  copyFile(chosenPath, AVATAR_PATH);
  db.prepare(
    "INSERT INTO avatar (id, image_path, updated_at) VALUES (1, ?, datetime('now')) " +
      "ON CONFLICT(id) DO UPDATE SET image_path = excluded.image_path, updated_at = excluded.updated_at"
  ).run(AVATAR_PATH);
  return AVATAR_PATH;
}

/** Removes the saved avatar so the picker flow can run again. Best-effort: a missing file never throws. */
export function clearSavedAvatar(db: Database.Database, deps: { rm?: typeof fs.rmSync } = {}): void {
  const rm = deps.rm ?? fs.rmSync;
  db.prepare('DELETE FROM avatar WHERE id = 1').run();
  try {
    rm(AVATAR_PATH, { force: true });
  } catch {
    // ignore — cleanup must never fail the clear operation
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/avatar.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/avatar.ts src/lib/avatar.test.ts
git commit -m "feat: add saved-avatar CRUD module"
```

---

### Task 4: `/api/avatar` routes

**Files:**
- Create: `src/app/api/avatar/route.ts` (GET, DELETE)
- Create: `src/app/api/avatar/generate/route.ts` (POST)
- Create: `src/app/api/avatar/choose/route.ts` (POST)
- Test: `src/app/api/avatar/route.test.ts`
- Test: `src/app/api/avatar/generate/route.test.ts`

**Interfaces:**
- Consumes: `getDb` (`@/lib/db`), `getSavedAvatarPath`/`saveAvatarChoice`/
  `clearSavedAvatar` (`@/lib/avatar`), `generateAvatarOptions` (`@/lib/face`).
- Produces: `GET /api/avatar` → `{ path: string | null }`. `DELETE
  /api/avatar` → `{ cleared: true }`. `POST /api/avatar/generate` (body `{
  prompt: string }`) → `{ paths: string[] }`. `POST /api/avatar/choose` (body
  `{ chosenPath: string }`) → `{ path: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/app/api/avatar/route.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `ugc-avatar-test-${Date.now()}.sqlite`);

beforeAll(() => { process.env.UGC_DB_PATH = tmpDb; });
afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
  delete process.env.UGC_DB_PATH;
});

import { GET, DELETE } from './route';
import { POST as choose } from './choose/route';

describe('avatar route', () => {
  it('returns null path when nothing saved yet', async () => {
    const res = await (await GET()).json();
    expect(res.path).toBeNull();
  });

  it('reflects a saved choice, then clears it', async () => {
    fs.mkdirSync('media/avatar-options', { recursive: true });
    fs.writeFileSync('media/avatar-options/option-0.jpg', 'fake');
    const chooseReq = new Request('http://localhost/api/avatar/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenPath: 'media/avatar-options/option-0.jpg' }),
    });
    const chosen = await (await choose(chooseReq)).json();
    expect(chosen.path).toBe('media/avatar.jpg');

    const got = await (await GET()).json();
    expect(got.path).toBe('media/avatar.jpg');

    const cleared = await (await DELETE()).json();
    expect(cleared.cleared).toBe(true);
    const gotAfter = await (await GET()).json();
    expect(gotAfter.path).toBeNull();

    fs.rmSync('media/avatar-options', { recursive: true, force: true });
    fs.rmSync('media/avatar.jpg', { force: true });
  });
});
```

```typescript
// src/app/api/avatar/generate/route.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/face', () => ({
  generateAvatarOptions: async (prompt: string, count: number, destDir: string) =>
    Array.from({ length: count }, (_, i) => `${destDir}/option-${i}.jpg`),
}));

import { POST } from './route';

describe('avatar generate route', () => {
  it('returns 3 generated option paths', async () => {
    const req = new Request('http://localhost/api/avatar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'young woman, studio lighting' }),
    });
    const res = await (await POST(req)).json();
    expect(res.paths).toHaveLength(3);
    expect(res.paths[0]).toContain('option-0.jpg');
  });

  it('rejects a missing prompt', async () => {
    const req = new Request('http://localhost/api/avatar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/avatar`
Expected: FAIL — routes don't exist yet

- [ ] **Step 3: Write the implementations**

```typescript
// src/app/api/avatar/route.ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSavedAvatarPath, clearSavedAvatar } from '@/lib/avatar';

export async function GET() {
  const db = getDb();
  return NextResponse.json({ path: getSavedAvatarPath(db) });
}

export async function DELETE() {
  const db = getDb();
  clearSavedAvatar(db);
  return NextResponse.json({ cleared: true });
}
```

```typescript
// src/app/api/avatar/generate/route.ts
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { generateAvatarOptions } from '@/lib/face';

const OPTIONS_DIR = 'media/avatar-options';

export async function POST(req: Request) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    // Clear stale options from a prior attempt before generating a fresh batch.
    fs.rmSync(OPTIONS_DIR, { recursive: true, force: true });
    const paths = await generateAvatarOptions(prompt, 3, OPTIONS_DIR);
    return NextResponse.json({ paths });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
```

```typescript
// src/app/api/avatar/choose/route.ts
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { saveAvatarChoice } from '@/lib/avatar';

const OPTIONS_DIR = 'media/avatar-options';

export async function POST(req: Request) {
  try {
    const { chosenPath } = (await req.json()) as { chosenPath?: string };
    if (!chosenPath) return NextResponse.json({ error: 'chosenPath is required' }, { status: 400 });
    const db = getDb();
    const path = saveAvatarChoice(db, chosenPath);
    // Best-effort: remove the option files now that one has been chosen and copied out.
    fs.rmSync(OPTIONS_DIR, { recursive: true, force: true });
    return NextResponse.json({ path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/avatar`
Expected: PASS (4 tests total)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/avatar
git commit -m "feat: add avatar generate/choose/get/delete API routes"
```

---

### Task 5: `jobs.ts` — rename, delete, and sweep failed jobs

**Files:**
- Modify: `src/lib/jobs.ts`
- Test: `src/lib/jobs.test.ts`

**Interfaces:**
- Consumes: existing `setJob` helper (already defined in `jobs.ts`).
- Produces: `renameJob(db: Database.Database, jobId: number, name: string):
  void`, `deleteJob(db: Database.Database, jobId: number, deps?: { rm?:
  typeof fs.rmSync }): void`, `sweepFailedJobs(db: Database.Database,
  olderThanMs?: number, deps?: { rm?: typeof fs.rmSync }): number` (default
  `olderThanMs` is `60 * 60 * 1000`; returns count of jobs swept).

- [ ] **Step 1: Write the failing tests**

```typescript
// append to src/lib/jobs.test.ts
import { renameJob, deleteJob, sweepFailedJobs } from './jobs';

describe('job management', () => {
  it('renames a job', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    renameJob(db, id, 'My Custom Name');
    const row = db.prepare('SELECT name FROM jobs WHERE id = ?').get(id) as any;
    expect(row.name).toBe('My Custom Name');
  });

  it('deletes a job and its media directory', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    const removed: string[] = [];
    deleteJob(db, id, { rm: (p: any) => { removed.push(p); } });
    const row = db.prepare('SELECT id FROM jobs WHERE id = ?').get(id);
    expect(row).toBeUndefined();
    expect(removed).toEqual([`media/jobs/${id}`]);
  });

  it('sweeps failed jobs older than the threshold but keeps recent ones', async () => {
    const db = getDb(':memory:');
    const oldId = seedJobWithFace(db);
    const recentId = seedJobWithFace(db);
    db.prepare("UPDATE jobs SET status = 'failed', updated_at = datetime('now', '-2 hours') WHERE id = ?").run(oldId);
    db.prepare("UPDATE jobs SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(recentId);
    const removed: string[] = [];
    const count = sweepFailedJobs(db, 60 * 60 * 1000, { rm: (p: any) => { removed.push(p); } });
    expect(count).toBe(1);
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(oldId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(recentId)).toBeDefined();
    expect(removed).toEqual([`media/jobs/${oldId}`]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: FAIL — `renameJob`/`deleteJob`/`sweepFailedJobs` not exported

- [ ] **Step 3: Write the implementation**

Add to `src/lib/jobs.ts` (near `approveCandidate`, after the `setJob` helper
definition):

```typescript
/** Sets a client-chosen display name for a job. */
export function renameJob(db: Database.Database, jobId: number, name: string): void {
  setJob(db, jobId, { name });
}

/** Deletes a job row and its media directory. Media removal is best-effort. */
export function deleteJob(db: Database.Database, jobId: number, deps: { rm?: typeof fs.rmSync } = {}): void {
  const rm = deps.rm ?? fs.rmSync;
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  try {
    rm(`media/jobs/${jobId}`, { recursive: true, force: true });
  } catch {
    // ignore — cleanup must never fail the delete operation
  }
}

/** Removes failed jobs older than `olderThanMs` (default 1 hour) so failures never pile up. Returns the count removed. */
export function sweepFailedJobs(
  db: Database.Database,
  olderThanMs = 60 * 60 * 1000,
  deps: { rm?: typeof fs.rmSync } = {}
): number {
  const cutoffSeconds = Math.floor(olderThanMs / 1000);
  const stale = db
    .prepare(`SELECT id FROM jobs WHERE status = 'failed' AND updated_at < datetime('now', '-' || ? || ' seconds')`)
    .all(cutoffSeconds) as { id: number }[];
  for (const { id } of stale) deleteJob(db, id, deps);
  return stale.length;
}
```

`fs` is already imported at the top of `jobs.ts` from Task 4 of the earlier
scraper plan (`import fs from 'node:fs';`) — reuse it, don't re-import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/jobs.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs.ts src/lib/jobs.test.ts
git commit -m "feat: add job rename, delete, and failed-job sweep"
```

---

### Task 6: `/api/jobs/[id]` route + wire the sweep into `GET /api/jobs`

**Files:**
- Create: `src/app/api/jobs/[id]/route.ts` (PATCH, DELETE)
- Modify: `src/app/api/jobs/route.ts` (GET calls `sweepFailedJobs` first)
- Test: `src/app/api/jobs/[id]/route.test.ts`
- Modify: `src/app/api/jobs/route.test.ts` (add a sweep-integration test)

**Interfaces:**
- Consumes: `renameJob`, `deleteJob`, `sweepFailedJobs` (`@/lib/jobs`, from
  Task 5).
- Produces: `PATCH /api/jobs/[id]` (body `{ name: string }`) → `{ name }`.
  `DELETE /api/jobs/[id]` → `{ deleted: true }`.

- [ ] **Step 1: Write the failing test for the new route**

```typescript
// src/app/api/jobs/[id]/route.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `ugc-job-id-test-${Date.now()}.sqlite`);

beforeAll(() => { process.env.UGC_DB_PATH = tmpDb; });
afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
  delete process.env.UGC_DB_PATH;
});

import { PATCH, DELETE } from './route';

async function seedJob() {
  const { getDb } = await import('@/lib/db');
  const db = getDb();
  const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Client');
  const product = db.prepare("INSERT INTO products (client_id, type) VALUES (?, 'skincare')").run(client.lastInsertRowid);
  const job = db.prepare('INSERT INTO jobs (product_id) VALUES (?)').run(Number(product.lastInsertRowid));
  return { db, jobId: Number(job.lastInsertRowid) };
}

describe('job [id] route', () => {
  it('renames a job', async () => {
    const { db, jobId } = await seedJob();
    const req = new Request(`http://localhost/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const res = await (await PATCH(req, { params: Promise.resolve({ id: String(jobId) }) })).json();
    expect(res.name).toBe('Renamed');
    const row = db.prepare('SELECT name FROM jobs WHERE id = ?').get(jobId) as any;
    expect(row.name).toBe('Renamed');
  });

  it('deletes a job', async () => {
    const { db, jobId } = await seedJob();
    const req = new Request(`http://localhost/api/jobs/${jobId}`, { method: 'DELETE' });
    const res = await (await DELETE(req, { params: Promise.resolve({ id: String(jobId) }) })).json();
    expect(res.deleted).toBe(true);
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/jobs/[id]/route.test.ts"`
Expected: FAIL — file/route doesn't exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/app/api/jobs/[id]/route.ts
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { renameJob, deleteJob } from '@/lib/jobs';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { name } = (await req.json()) as { name: string };
    const db = getDb();
    renameJob(db, Number(id), name);
    return NextResponse.json({ name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    deleteJob(db, Number(id));
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/jobs/[id]/route.test.ts"`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing test for the sweep integration**

Append to `src/app/api/jobs/route.test.ts`:

```typescript
it('sweeps stale failed jobs before listing', async () => {
  const { getDb } = await import('@/lib/db');
  const db = getDb();
  const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Sweep Client');
  const product = db
    .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'skincare', 'beauty', '[]')")
    .run(client.lastInsertRowid);
  const job = db.prepare('INSERT INTO jobs (product_id, status) VALUES (?, ?)').run(Number(product.lastInsertRowid), 'failed');
  const staleId = Number(job.lastInsertRowid);
  db.prepare("UPDATE jobs SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(staleId);

  const listed = await (await GET()).json();
  expect(listed.jobs.some((j: any) => j.id === staleId)).toBe(false);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: FAIL — the stale job is still returned (GET doesn't sweep yet)

- [ ] **Step 7: Wire the sweep into `GET /api/jobs`**

In `src/app/api/jobs/route.ts`, modify the `GET` function:

```typescript
import { sweepFailedJobs } from '@/lib/jobs';

export async function GET() {
  const db = getDb();
  sweepFailedJobs(db);
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  return NextResponse.json({ jobs });
}
```

(Add `sweepFailedJobs` to the existing `import { createJob } from
'@/lib/jobs';` line rather than a separate import statement.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/app/api/jobs/route.test.ts`
Expected: PASS (all tests, including the new sweep test)

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add "src/app/api/jobs/[id]" src/app/api/jobs/route.ts src/app/api/jobs/route.test.ts
git commit -m "feat: add job rename/delete route and wire failed-job sweep into job listing"
```

---

### Task 7: `ProductUpload.tsx` — avatar picker + post-submit form hide

**Files:**
- Modify: `src/app/components/ProductUpload.tsx`

**Interfaces:**
- Consumes: `GET /api/avatar`, `POST /api/avatar/generate`, `POST
  /api/avatar/choose` (Task 4); existing `POST /api/jobs`, `POST
  /api/products`.

No automated test for this task — the project has no existing UI component
tests (`src/app/components/*.test.*` do not exist today), so this task is
verified manually per the steps below, matching the codebase's existing
depth of coverage.

- [ ] **Step 1: Add avatar state and fetch the saved avatar on mount**

In `src/app/components/ProductUpload.tsx`, add near the top of the
component body (after the existing `useState` calls):

```typescript
const [savedAvatarPath, setSavedAvatarPath] = useState<string | null>(null);
const [avatarOptions, setAvatarOptions] = useState<string[] | null>(null);
const [avatarBusy, setAvatarBusy] = useState(false);
const [submitted, setSubmitted] = useState(false);

useEffect(() => {
  fetch('/api/avatar').then((r) => r.json()).then((d) => setSavedAvatarPath(d.path));
}, []);
```

Add `useEffect` to the existing `import { useState } from 'react';` line:
`import { useState, useEffect } from 'react';`.

- [ ] **Step 2: Extend `faceMode` to a three-way choice**

Change the type of `faceMode` from `'upload' | 'generate'` to `'upload' |
'generate' | 'saved'`. Update the mode-toggle button row:

```tsx
<div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
  {(savedAvatarPath ? (['saved', 'upload', 'generate'] as const) : (['upload', 'generate'] as const)).map((mode) => (
    <button
      key={mode}
      onClick={() => { setFaceMode(mode); setFaceB64(null); setFaceName(null); setFacePrompt(''); setAvatarOptions(null); }}
      disabled={busy}
      style={{
        padding: '6px 14px',
        borderRadius: '6px',
        border: '1px solid #0070f3',
        background: faceMode === mode ? '#0070f3' : '#fff',
        color: faceMode === mode ? '#fff' : '#0070f3',
        cursor: busy ? 'not-allowed' : 'pointer',
        fontWeight: 600,
      }}
    >
      {mode === 'upload' ? 'Upload photo' : mode === 'generate' ? 'Create a new avatar' : 'Use saved avatar'}
    </button>
  ))}
</div>
```

Set the initial `faceMode` default based on whether a saved avatar exists —
change the `useState('upload')` line for `faceMode` to default lazily once
the avatar fetch resolves: in the Step 1 `useEffect`, after setting
`savedAvatarPath`, also do `if (d.path) setFaceMode('saved');` inside the
`.then((d) => { ... })` callback (expand the arrow function body accordingly).

- [ ] **Step 3: Render the "saved" mode and the avatar-options picker**

Add a new conditional block alongside the existing `faceMode === 'upload'`
and `faceMode === 'generate'` blocks:

```tsx
{faceMode === 'saved' && savedAvatarPath && (
  <div>
    <img src={'/' + savedAvatarPath} alt="Saved avatar" style={{ width: 120, borderRadius: 8 }} />
  </div>
)}
```

Change the existing `faceMode === 'generate'` block to add a "Generate
options" button and render the resulting picker instead of going straight to
job creation:

```tsx
{faceMode === 'generate' && (
  <div>
    <textarea
      rows={3}
      placeholder="Describe the avatar, e.g. 'Young Indonesian woman, natural makeup, friendly smile, studio lighting'"
      value={facePrompt}
      onChange={(e) => setFacePrompt(e.target.value)}
      disabled={busy || avatarBusy}
      style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ccc', fontFamily: 'inherit', resize: 'vertical' }}
    />
    <button
      onClick={async () => {
        setAvatarBusy(true);
        setError(null);
        try {
          const res = await fetch('/api/avatar/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: facePrompt.trim() }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Avatar generation failed');
          setAvatarOptions(data.paths);
        } catch (err: any) {
          setError(err.message ?? 'Avatar generation failed');
        } finally {
          setAvatarBusy(false);
        }
      }}
      disabled={busy || avatarBusy || !facePrompt.trim()}
      style={{ marginTop: '0.5rem', padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#0070f3', color: '#fff', cursor: 'pointer' }}
    >
      {avatarBusy ? 'Generating…' : 'Generate options'}
    </button>
    <p style={{ fontSize: '0.8rem', color: '#666', margin: '4px 0 0' }}>
      Generates 3 options to choose from (adds ~2 min). Your choice is saved and reused for future videos.
    </p>

    {avatarOptions && (
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
        {avatarOptions.map((p) => (
          <div key={p} style={{ textAlign: 'center' }}>
            <img src={'/' + p} alt="Avatar option" style={{ width: 100, borderRadius: 8, display: 'block' }} />
            <button
              onClick={async () => {
                setAvatarBusy(true);
                try {
                  const res = await fetch('/api/avatar/choose', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chosenPath: p }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error ?? 'Could not save avatar choice');
                  setSavedAvatarPath(data.path);
                  setAvatarOptions(null);
                  setFaceMode('saved');
                } catch (err: any) {
                  setError(err.message ?? 'Could not save avatar choice');
                } finally {
                  setAvatarBusy(false);
                }
              }}
              disabled={avatarBusy}
              style={{ marginTop: 4, padding: '2px 8px', fontSize: '0.75rem', borderRadius: 4, border: 'none', background: '#0070f3', color: '#fff', cursor: 'pointer' }}
            >
              Use this
            </button>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```

- [ ] **Step 4: Update `faceReady` and `start()` for the `saved` mode**

Change the `faceReady` line:

```typescript
const faceReady = faceMode === 'upload' ? !!faceB64 : faceMode === 'saved' ? !!savedAvatarPath : facePrompt.trim().length > 0 && !avatarOptions;
```

(The `&& !avatarOptions` on the `generate` branch prevents submitting while
options are shown but not yet chosen — the "Use this" flow above switches
`faceMode` to `'saved'` once a choice is made, so `generate` mode alone
should never itself be submittable.)

In `start()`, change the body-building logic: since `saved` mode should
behave exactly like `upload` mode (send bytes as `faceImageBase64`), fetch
the saved avatar's bytes client-side before submitting. Replace the
`if (faceMode === 'upload') { ... } else { ... }` block with:

```typescript
if (faceMode === 'upload') {
  body.faceImageBase64 = faceB64;
} else if (faceMode === 'saved') {
  const avatarRes = await fetch('/' + savedAvatarPath);
  const avatarBuf = await avatarRes.arrayBuffer();
  const bytes = new Uint8Array(avatarBuf);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  body.faceImageBase64 = btoa(binary);
} else {
  body.facePrompt = facePrompt.trim();
}
```

(`faceMode === 'generate'` should be unreachable at submit time per Step 4's
`faceReady` change, but this keeps the `else` branch as a safe fallback
rather than silently sending nothing.)

- [ ] **Step 5: Hide the form after a successful submit**

At the end of the `try` block in `start()`, after the existing
`onJobCreated?.();` line, add `setSubmitted(true);`.

Wrap the component's `return (...)` JSX: change the outermost `<section>`'s
children to be conditional on `submitted`. Add near the top of the return
statement:

```tsx
if (submitted) {
  return (
    <section style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px', color: '#171717' }}>
      <p style={{ color: '#2e7d32', marginBottom: '1rem' }}>{status}</p>
      <button
        onClick={() => {
          setSubmitted(false);
          setResult(null);
          setFaceB64(null);
          setFaceName(null);
          setFacePrompt('');
          setAvatarOptions(null);
          setStatus(null);
          setError(null);
        }}
        style={{ padding: '8px 16px', fontWeight: 600, cursor: 'pointer', background: '#0070f3', color: '#fff', border: 'none', borderRadius: '6px' }}
      >
        Start another job
      </button>
    </section>
  );
}
```

Place this `if` block immediately before the existing `return (` statement
(i.e., as its own early return inside the component function, before the
main JSX return).

- [ ] **Step 6: Manually verify**

Run the dev server (`npm run dev`), then:
1. Upload a product photo, choose "Create a new avatar", type a prompt,
   click "Generate options" — confirm 3 images appear.
2. Click "Use this" on one — confirm it switches to "Use saved avatar" mode
   showing that image.
3. Click "Generate video" — confirm the form disappears and a "Start
   another job" button appears instead.
4. Click "Start another job", upload a new product photo — confirm "Use
   saved avatar" is now the default pre-selected mode and shows the
   previously chosen avatar without regenerating.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/ProductUpload.tsx
git commit -m "feat: add avatar picker and post-submit form hide to ProductUpload"
```

---

### Task 8: `JobQueue.tsx` — rename, delete, dismiss failed jobs

**Files:**
- Modify: `src/app/components/JobQueue.tsx`

**Interfaces:**
- Consumes: `PATCH /api/jobs/[id]`, `DELETE /api/jobs/[id]` (Task 6).

No automated test for this task, matching Task 7 (no existing UI component
test coverage in this codebase).

- [ ] **Step 1: Add rename state and a rename handler**

Add near the top of the `JobQueue` component body:

```typescript
const [editingId, setEditingId] = useState<number | null>(null);
const [editingName, setEditingName] = useState('');

async function rename(jobId: number, name: string) {
  await fetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  setEditingId(null);
  await fetchJobs();
}

async function removeJob(jobId: number) {
  await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
  await fetchJobs();
}
```

Add `name?: string | null;` to the `Job` type definition near the top of the
file (alongside `error?: string | null;`).

- [ ] **Step 2: Make the job title click-to-edit**

Replace the line:

```tsx
<span style={{ fontWeight: 600 }}>{JOB_LABEL} #{job.id}</span>
```

with:

```tsx
{editingId === job.id ? (
  <input
    autoFocus
    value={editingName}
    onChange={(e) => setEditingName(e.target.value)}
    onBlur={() => rename(job.id, editingName.trim() || `${JOB_LABEL} #${job.id}`)}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    style={{ fontWeight: 600, fontSize: '1rem', border: '1px solid #0070f3', borderRadius: 4, padding: '2px 6px' }}
  />
) : (
  <span
    onClick={() => { setEditingId(job.id); setEditingName(job.name ?? `${JOB_LABEL} #${job.id}`); }}
    style={{ fontWeight: 600, cursor: 'pointer' }}
    title="Click to rename"
  >
    {job.name ?? `${JOB_LABEL} #${job.id}`}
  </span>
)}
```

- [ ] **Step 3: Add delete/dismiss buttons**

In the top `<div>` row of each job (the one containing the status badge and
the `View →` link), add a delete button at the end:

```tsx
<button
  onClick={() => { if (confirm(`Delete ${job.name ?? `${JOB_LABEL} #${job.id}`}?`)) removeJob(job.id); }}
  title="Delete this job"
  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '1rem' }}
>
  🗑
</button>
```

For failed jobs specifically, add a "Dismiss" button next to the existing
error message. Change:

```tsx
{job.error && (
  <p style={{ color: 'red', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>Error: {job.error}</p>
)}
```

to:

```tsx
{job.error && (
  <p style={{ color: 'red', margin: '0.5rem 0 0', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
    <span>Error: {job.error}</span>
    {job.status === 'failed' && (
      <button
        onClick={() => removeJob(job.id)}
        style={{ padding: '2px 8px', fontSize: '0.75rem', borderRadius: 4, border: '1px solid #F44336', background: '#fff', color: '#F44336', cursor: 'pointer' }}
      >
        Dismiss
      </button>
    )}
  </p>
)}
```

- [ ] **Step 4: Manually verify**

Run the dev server, then:
1. Click a job's title — confirm it becomes an editable text input; type a
   new name and press Enter — confirm it saves and displays the new name.
2. Click the 🗑 button on a job — confirm a browser confirm dialog appears,
   and confirming removes the job from the list.
3. Force a job into `failed` status (or wait for a real failure) — confirm
   the error message shows a "Dismiss" button that removes it.
4. Manually set a job's `updated_at` to over an hour ago with status
   `failed` (via a SQLite client or `sqlite3 media/app.sqlite "UPDATE jobs
   SET status='failed', updated_at=datetime('now','-2 hours') WHERE
   id=<some-id>;"`), then reload the page — confirm it's gone from the list
   without manual dismissal.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/JobQueue.tsx
git commit -m "feat: add job rename, delete, and dismiss-failed to JobQueue"
```
