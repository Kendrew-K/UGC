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

// Job creation writes real files under media/jobs/<id>, and this suite shares
// the developer's actual media/ dir. Force all test job ids into a range no
// real job will ever reach so test dirs never collide with (or delete!) real ones.
const TEST_ID_FLOOR = 999_999_000;
const createdJobIds: number[] = [];

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
    // Pin the id sequence above the floor: sqlite hands out max(id)+1 next.
    db.prepare('INSERT INTO jobs (id, product_id, status) VALUES (?, ?, ?)').run(TEST_ID_FLOOR, productId, 'ready');

    const create = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, count: 3, faceImageBase64: Buffer.from('fake-jpeg').toString('base64'), answers: { vibe: 'GRWM' } }),
    });
    const created = await (await POST(create)).json();
    createdJobIds.push(...created.jobIds);
    expect(created.jobIds).toHaveLength(3);
    expect(created.jobIds.every((id: number) => id > TEST_ID_FLOOR)).toBe(true);
    const listed = await (await GET()).json();
    expect(listed.jobs.length).toBeGreaterThanOrEqual(3);
    // Each job should have its face photo persisted.
    const row = db.prepare('SELECT face_image_path FROM jobs WHERE id = ?').get(created.jobIds[0]) as any;
    expect(row.face_image_path).toContain('face.jpg');
  });

  it('creates a generating_face job when facePrompt is supplied', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Prompt Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'fashion', 'clothing', '[]')")
      .run(client.lastInsertRowid);
    const productId = Number(product.lastInsertRowid);

    const req = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, facePrompt: 'young woman, studio lighting' }),
    });
    const res = await (await POST(req)).json();
    createdJobIds.push(...res.jobIds);
    expect(res.jobIds).toHaveLength(1);
    const row = db.prepare('SELECT status, face_prompt FROM jobs WHERE id = ?').get(res.jobIds[0]) as any;
    expect(row.status).toBe('generating_face');
    expect(row.face_prompt).toBe('young woman, studio lighting');
  });

  it('creates a picture-mode job', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Picture Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'fashion', 'clothing', '[]')")
      .run(client.lastInsertRowid);
    const productId = Number(product.lastInsertRowid);

    const req = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, faceImageBase64: Buffer.from('fake-jpeg').toString('base64'), mediaType: 'picture' }),
    });
    const res = await (await POST(req)).json();
    createdJobIds.push(...res.jobIds);
    const row = db.prepare('SELECT media_type FROM jobs WHERE id = ?').get(res.jobIds[0]) as { media_type: string };
    expect(row.media_type).toBe('picture');
  });

  it('defaults media_type to video when mediaType is omitted', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Default Media Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'fashion', 'clothing', '[]')")
      .run(client.lastInsertRowid);
    const productId = Number(product.lastInsertRowid);

    const req = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, faceImageBase64: Buffer.from('fake-jpeg').toString('base64') }),
    });
    const res = await (await POST(req)).json();
    createdJobIds.push(...res.jobIds);
    const row = db.prepare('SELECT media_type FROM jobs WHERE id = ?').get(res.jobIds[0]) as { media_type: string };
    expect(row.media_type).toBe('video');
  });

  it('rejects requests with neither faceImageBase64 nor facePrompt', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('No Face Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'skincare', 'beauty', '[]')")
      .run(client.lastInsertRowid);
    const req = new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: Number(product.lastInsertRowid) }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/face/i);
  });

  it('sweeps stale failed jobs before listing', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Sweep Client');
    const product = db
      .prepare("INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, 'skincare', 'beauty', '[]')")
      .run(client.lastInsertRowid);
    // Explicit huge id: the sweep really deletes media/jobs/<id>, and this
    // suite shares the developer's real media/ dir — the id must never
    // collide with an actual job's directory.
    const staleId = 999_999_901;
    db.prepare('INSERT INTO jobs (id, product_id, status) VALUES (?, ?, ?)').run(staleId, Number(product.lastInsertRowid), 'failed');
    db.prepare("UPDATE jobs SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(staleId);

    const listed = await (await GET()).json();
    expect(listed.jobs.some((j: any) => j.id === staleId)).toBe(false);
  });

  afterAll(() => {
    // Remove ONLY this suite's job dirs — never the whole media/jobs tree
    // (that once deleted a user's real in-flight job output).
    for (const id of createdJobIds) {
      try { fs.rmSync(`media/jobs/${id}`, { recursive: true, force: true }); } catch {}
    }
  });
});
