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
