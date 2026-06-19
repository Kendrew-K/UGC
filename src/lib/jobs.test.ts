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
