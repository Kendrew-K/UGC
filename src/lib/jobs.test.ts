import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { createJob, advanceJob, approveCandidate, type PipelineSteps } from './jobs';
import type { Candidate } from './scraper';

function seedProduct(db: ReturnType<typeof getDb>) {
  const cl = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Acme');
  const pr = db.prepare('INSERT INTO products (client_id, type) VALUES (?, ?)').run(cl.lastInsertRowid, 'makeup');
  return Number(pr.lastInsertRowid);
}

const candidate: Candidate = { url: 'a', views: 9_000_000, downloadUrl: 'http://v/a.mp4', hasVoice: false, platform: 'tiktok' };

const okSteps: PipelineSteps = {
  generateFace: async (_prompt: string, destPath: string) => destPath,
  findCandidates: async () => [candidate],
  prepareSource: async () => 'media/src.mp4',
  swap: async () => 'media/swapped.mp4',
  process: async () => 'media/final.mp4',
};

function seedJobWithFace(db: ReturnType<typeof getDb>) {
  const id = createJob(db, seedProduct(db));
  db.prepare("UPDATE jobs SET face_image_path = 'media/face.jpg' WHERE id = ?").run(id);
  return id;
}

describe('job pipeline', () => {
  it('runs queued -> approval -> ready across advances', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    let status = await advanceJob(db, id, okSteps); // -> awaiting_approval
    expect(status).toBe('awaiting_approval');
    status = await advanceJob(db, id, okSteps); // still awaiting (held for client)
    expect(status).toBe('awaiting_approval');
    expect(approveCandidate(db, id, 0)).toBe('downloading');
    status = await advanceJob(db, id, okSteps); // downloading -> swapping
    expect(status).toBe('swapping');
    status = await advanceJob(db, id, okSteps); // swapping -> processing
    expect(status).toBe('processing');
    status = await advanceJob(db, id, okSteps); // processing -> ready
    expect(status).toBe('ready');
    const row = db.prepare('SELECT output_path, status FROM jobs WHERE id = ?').get(id) as any;
    expect(row.output_path).toBe('media/final.mp4');
    expect(row.status).toBe('ready');
  });

  it('marks job failed and records error when a step throws', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    const badSteps = { ...okSteps, findCandidates: async () => { throw new Error('apify down'); } };
    const status = await advanceJob(db, id, badSteps);
    expect(status).toBe('failed');
    const row = db.prepare('SELECT error FROM jobs WHERE id = ?').get(id) as any;
    expect(row.error).toContain('apify down');
  });

  it('fails approval when the job is not awaiting a choice', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    expect(() => approveCandidate(db, id, 0)).toThrow(/not awaiting approval/i);
  });

  it('generating_face -> queued: generates face, saves path, advances to queued', async () => {
    const db = getDb(':memory:');
    const productId = seedProduct(db);
    const jobId = createJob(db, productId, { status: 'generating_face', facePrompt: 'young woman, studio' });
    let generatedPrompt = '';
    const steps: PipelineSteps = {
      ...okSteps,
      generateFace: async (prompt, destPath) => { generatedPrompt = prompt; return destPath; },
    };
    const status = await advanceJob(db, jobId, steps);
    expect(status).toBe('queued');
    expect(generatedPrompt).toBe('young woman, studio');
    const row = db.prepare('SELECT face_image_path, status FROM jobs WHERE id = ?').get(jobId) as any;
    expect(row.status).toBe('queued');
    expect(row.face_image_path).toContain('face.jpg');
  });

  it('generating_face fails when no face_prompt stored', async () => {
    const db = getDb(':memory:');
    const jobId = createJob(db, seedProduct(db), { status: 'generating_face' });
    const status = await advanceJob(db, jobId, okSteps);
    expect(status).toBe('failed');
    const row = db.prepare('SELECT error FROM jobs WHERE id = ?').get(jobId) as any;
    expect(row.error).toMatch(/no face prompt/i);
  });

  it('can retry a failed job from the start', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    await advanceJob(db, id, { ...okSteps, findCandidates: async () => { throw new Error('x'); } });
    db.prepare("UPDATE jobs SET status = 'queued', error = NULL WHERE id = ?").run(id);
    const status = await advanceJob(db, id, okSteps);
    expect(status).toBe('awaiting_approval');
  });
});
