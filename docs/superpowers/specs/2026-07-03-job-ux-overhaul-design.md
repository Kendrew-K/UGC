# Design: Job/Avatar UX overhaul

Date: 2026-07-03

## Goal

Five related UX fixes to the job-creation and job-queue flow:

1. Avatar generation produces 3 options to choose from, not an immediate
   single avatar baked into one video. The chosen avatar is saved and reused
   for all future videos instead of regenerating every time.
2. Pressing "Generate video" removes the upload form so it can't be
   double-clicked (saves API credits from accidental duplicate jobs).
3. Jobs can be renamed instead of showing only "{JOB_LABEL} #{id}".
4. Jobs can be manually deleted from the queue.
5. Failed jobs are automatically cleaned up.

## Assumptions (no objection raised, proceeding on these)

- One global saved avatar, not per-client/per-product — matches how the app
  is actually used today (single hardcoded "Me" client, no real multi-tenant
  UI).
- The saved avatar can be regenerated later via an explicit action, not
  locked in permanently.
- After a successful job submission, the form disappears entirely, replaced
  by a "Start another job" button.
- Failed jobs show their error with a manual "Dismiss" button, and are also
  automatically swept if left failed for over an hour.

## Data model

`src/lib/db/schema.sql` gains:

```sql
CREATE TABLE IF NOT EXISTS avatar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  image_path TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

(Singleton table: exactly one row, enforced by the `CHECK (id = 1)` constraint
plus `INSERT OR REPLACE`.)

`jobs` gains one nullable column: `name TEXT`.

## Avatar picker flow

**`src/lib/face.ts`** gains:

```ts
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

**New API routes:**
- `POST /api/avatar/generate` — body `{ prompt }`. Clears
  `media/avatar-options` (best-effort `rmSync(..., { recursive: true, force:
  true })`) before calling `generateAvatarOptions(prompt, 3,
  'media/avatar-options')`, so stale options from a prior attempt don't
  linger or get confused with the new batch. Returns `{ paths: string[] }`
  (servable via the existing `/media/[...path]` route).
- `POST /api/avatar/choose` — body `{ chosenPath }`. Copies the chosen file
  to `media/avatar.jpg`, deletes the other option files, upserts the
  `avatar` row (`INSERT OR REPLACE INTO avatar (id, image_path) VALUES (1, ?)`).
  Returns `{ path: 'media/avatar.jpg' }`.
- `GET /api/avatar` — returns `{ path: string | null }` (null if no row yet).
- `DELETE /api/avatar` — deletes the row and the file, so the picker flow can
  run again.

**`ProductUpload.tsx`** face-choice step becomes three-way instead of two-way:
- **Use saved avatar** (shown as a thumbnail, pre-selected by default when
  `GET /api/avatar` returns a path).
- **Upload a photo** (unchanged from today).
- **Create a new avatar** — opens the prompt textarea + "Generate options"
  button; on click, calls `/api/avatar/generate`, shows the 3 returned images
  in a row, each with a "Use this" button that calls `/api/avatar/choose`
  and then switches the mode back to "Use saved avatar" with the new image.

When "Use saved avatar" is selected, job creation (`POST /api/jobs`) is called
exactly like today's `upload` mode — it reads `media/avatar.jpg` and passes
its bytes as `faceImageBase64`, so no job-pipeline changes are needed. The
existing `generating_face` job status and pipeline step are left as-is
(unused by the new flow, not removed — no other caller currently depends on
removing them, and removing them is out of scope for this pass).

## Prevent double-submit

`ProductUpload.tsx`: on successful `POST /api/jobs`, set a new `submitted`
state to `true` instead of just showing a status message. When `submitted` is
true, render only a "Start another job" button; clicking it resets all form
state (`result`, `faceMode`, `faceB64`, `facePrompt`, `submitted`) back to
initial, remounting the full form.

## Rename + delete jobs

**`src/lib/db/index.ts`**: following the existing idempotent-migration
pattern there (e.g. `if (!hasJob('face_prompt')) db.exec('ALTER TABLE jobs
ADD COLUMN face_prompt TEXT')`), add `if (!hasJob('name')) db.exec('ALTER
TABLE jobs ADD COLUMN name TEXT')`.

**New API routes:**
- `PATCH /api/jobs/[id]` — body `{ name }`. Runs
  `UPDATE jobs SET name = ? WHERE id = ?`. Returns `{ name }`.
- `DELETE /api/jobs/[id]` — deletes the job row and recursively removes
  `media/jobs/{id}` if it exists. Returns `{ deleted: true }`.

**`JobQueue.tsx`**:
- Job title becomes click-to-edit: clicking the label swaps it for a text
  input pre-filled with the current name (or `"{JOB_LABEL} #{id}"`); Enter or
  blur calls `PATCH /api/jobs/{id}` and refreshes.
- A small 🗑 delete button next to each job calls
  `DELETE /api/jobs/{id}` after a `confirm()` prompt, then refreshes.

## Auto-sweep failed jobs

**`src/app/api/jobs/route.ts`**'s `GET` handler runs, before selecting:

```sql
DELETE FROM jobs WHERE status = 'failed' AND updated_at < datetime('now', '-1 hour')
```

(plus removing each swept job's `media/jobs/{id}` directory, best-effort,
same pattern as the existing job-cleanup code in `jobs.ts`).

**`JobQueue.tsx`**: each job with `status === 'failed'` gets a "Dismiss"
button (reuses the same `DELETE /api/jobs/{id}` endpoint as manual delete).

## Error handling

- Avatar generation failures (`/api/avatar/generate`) surface the same way
  existing API routes do: caught, returned as `{ error }` with a non-2xx
  status, shown in the UI's existing error-message area.
- Deleting a job whose media directory is already gone must not fail the
  request (best-effort `fs.rmSync(..., { recursive: true, force: true })`,
  matching the existing cleanup pattern in `jobs.ts`).
- The auto-sweep is a fire-and-forget best-effort operation inside `GET
  /api/jobs` — if the media-directory removal for a swept job fails, the DB
  deletion still proceeds (row deletion and file cleanup are independent;
  a failed cleanup just leaves an orphaned folder, not a broken job).

## Testing

- `face.ts`: unit test for `generateAvatarOptions` using injected
  `generate`/`download` fakes (matching the existing `resolveFace` test
  pattern) — verifies 3 calls, 3 distinct destination paths.
- New avatar API routes: unit tests using an in-memory DB (matching
  `jobs.test.ts`'s pattern) for the choose/get/delete DB logic; generate
  route tested via injected fakes, not real KIE calls.
- `jobs.ts` / job routes: unit tests for rename, delete (row + directory),
  and the failed-job sweep (seed an old failed job + a recent one, assert
  only the old one is removed).
- No new browser/E2E tests — matches the project's existing testing depth
  (unit tests + manual verification for UI).

## Out of scope (explicitly deferred)

- Removing the now-mostly-unused `generating_face` job status/pipeline step.
- Multi-client / multi-avatar support (one global avatar only, per the
  assumption above).
- Any change to how many avatar options are generated (fixed at 3).
- Configurable auto-sweep window (hardcoded at 1 hour).
