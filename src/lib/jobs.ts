import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Candidate } from './scraper';

export type JobStatus =
  | 'generating_face'
  | 'queued'
  | 'awaiting_approval'
  | 'downloading'
  | 'swapping'
  | 'processing'
  | 'ready'
  | 'failed';

/** Statuses the client-side driver may advance automatically (no human input needed). */
export const AUTO_ADVANCE_STATUSES: JobStatus[] = ['generating_face', 'queued', 'downloading', 'swapping', 'processing'];

export interface PipelineSteps {
  /** Generate an AI avatar from face_prompt and save it to face.jpg, returning its local path. */
  generateFace(prompt: string, destPath: string): Promise<string>;
  /** Find viral source candidates for the client to choose from. */
  findCandidates(): Promise<Candidate[]>;
  /** Download the client-approved candidate, returning the local source path. */
  prepareSource(chosen: Candidate): Promise<string>;
  swap(sourcePath: string): Promise<string>;
  process(swappedPath: string): Promise<string>;
}

export function createJob(
  db: Database.Database,
  productId: number,
  opts: { status?: JobStatus; facePrompt?: string } = {}
): number {
  const status = opts.status ?? 'queued';
  const info = db
    .prepare('INSERT INTO jobs (product_id, status, face_prompt) VALUES (?, ?, ?)')
    .run(productId, status, opts.facePrompt ?? null);
  return Number(info.lastInsertRowid);
}

function setJob(db: Database.Database, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

/** Record the client's chosen candidate and release the job to continue automatically. */
export function approveCandidate(db: Database.Database, jobId: number, chosenIndex: number): JobStatus {
  const job = db.prepare('SELECT status, candidates_json FROM jobs WHERE id = ?').get(jobId) as
    | { status: JobStatus; candidates_json: string | null }
    | undefined;
  if (!job) throw new Error('job not found');
  if (job.status !== 'awaiting_approval') throw new Error(`job is not awaiting approval (status: ${job.status})`);
  const candidates = JSON.parse(job.candidates_json ?? '[]') as Candidate[];
  const chosen = candidates[chosenIndex];
  if (!chosen) throw new Error('invalid candidate selection');
  setJob(db, jobId, { status: 'downloading', chosen_candidate_json: JSON.stringify(chosen) });
  return 'downloading';
}

export async function advanceJob(db: Database.Database, jobId: number, steps: PipelineSteps): Promise<JobStatus> {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  const status = job.status as JobStatus;
  try {
    if (status === 'generating_face') {
      if (!job.face_prompt) throw new Error('No face prompt stored for this job');
      const destPath = `media/jobs/${jobId}/face.jpg`;
      const facePath = await steps.generateFace(job.face_prompt, destPath);
      setJob(db, jobId, { status: 'queued', face_image_path: facePath });
      return 'queued';
    }
    if (status === 'queued') {
      const candidates = await steps.findCandidates();
      if (candidates.length === 0) throw new Error('No viral candidates found');
      setJob(db, jobId, { status: 'awaiting_approval', candidates_json: JSON.stringify(candidates) });
      return 'awaiting_approval';
    }
    if (status === 'awaiting_approval') {
      // Held for the client to pick a clip; resumed via approveCandidate().
      return 'awaiting_approval';
    }
    if (status === 'downloading') {
      if (!job.chosen_candidate_json) throw new Error('No clip selected');
      const chosen = JSON.parse(job.chosen_candidate_json) as Candidate;
      const sourcePath = await steps.prepareSource(chosen);
      setJob(db, jobId, { status: 'swapping', source_video_path: sourcePath });
      return 'swapping';
    }
    if (status === 'swapping') {
      if (!job.face_image_path) throw new Error('No face image uploaded for this job');
      const swapped = await steps.swap(job.source_video_path);
      setJob(db, jobId, { status: 'processing', output_path: swapped });
      return 'processing';
    }
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
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (status === 'downloading') {
      // Download failures are often per-clip (TikTok inconsistently blocks or
      // omits the CDN URL for a given video) -- let the client pick a
      // different candidate from the same list instead of dead-ending the job.
      setJob(db, jobId, { status: 'awaiting_approval', chosen_candidate_json: null, error: message });
      return 'awaiting_approval';
    }
    setJob(db, jobId, { status: 'failed', error: message });
    return 'failed';
  }
}
