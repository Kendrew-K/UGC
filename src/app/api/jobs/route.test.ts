import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `ugc-jobs-test-${Date.now()}.sqlite`);

beforeAll(() => {
  process.env.UGC_DB_PATH = tmpDb;
});

afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
  delete process.env.UGC_DB_PATH;
});

import { POST, GET } from './route';

describe('jobs route', () => {
  it('creates N queued jobs and lists them', async () => {
    // Seed a client + product first (FK constraint)
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Test Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'skincare', 'beauty', '[]')")
      .run(client.lastInsertRowid);
    const productId = Number(product.lastInsertRowid);

    const create = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, count: 3, faceSource: { kind: 'upload', path: 'media/f.jpg' }, answers: { vibe: 'GRWM' } }),
    });
    const created = await (await POST(create)).json();
    expect(created.jobIds).toHaveLength(3);
    const listed = await (await GET()).json();
    expect(listed.jobs.length).toBeGreaterThanOrEqual(3);
  });
});
