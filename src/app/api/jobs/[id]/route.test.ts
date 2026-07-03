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
