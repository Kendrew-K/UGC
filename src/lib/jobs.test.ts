import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { createJob, advanceJob, approveCandidate, renameJob, deleteJob, sweepFailedJobs, type PipelineSteps } from './jobs';
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
  generate: async () => 'media/swapped.mp4',
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
    status = await advanceJob(db, id, okSteps); // downloading -> generating
    expect(status).toBe('generating');
    status = await advanceJob(db, id, okSteps); // generating -> processing
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

  it('returns to awaiting_approval (not failed) when the chosen clip fails to download, so the client can pick another', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    await advanceJob(db, id, okSteps); // -> awaiting_approval
    approveCandidate(db, id, 0); // -> downloading
    const status = await advanceJob(db, id, {
      ...okSteps,
      prepareSource: async () => { throw new Error('no downloadable video URL found on page'); },
    });
    expect(status).toBe('awaiting_approval');
    const row = db.prepare('SELECT status, error, candidates_json, chosen_candidate_json FROM jobs WHERE id = ?').get(id) as any;
    expect(row.status).toBe('awaiting_approval');
    expect(row.error).toMatch(/no downloadable video url/i);
    expect(row.chosen_candidate_json).toBeNull();
    expect(JSON.parse(row.candidates_json)).toHaveLength(1);
    // client can immediately pick again
    expect(approveCandidate(db, id, 0)).toBe('downloading');
  });

  it('returns to awaiting_approval (not failed) when the swap output fails quality check, so the client can pick another clip', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    await advanceJob(db, id, okSteps); // -> awaiting_approval
    approveCandidate(db, id, 0); // -> downloading
    await advanceJob(db, id, okSteps); // -> generating
    const status = await advanceJob(db, id, {
      ...okSteps,
      generate: async () => { throw new Error('quality check failed: three legs in frame 2'); },
    });
    expect(status).toBe('awaiting_approval');
    const row = db.prepare('SELECT status, error, chosen_candidate_json FROM jobs WHERE id = ?').get(id) as any;
    expect(row.error).toMatch(/three legs/);
    expect(row.chosen_candidate_json).toBeNull();
    expect(approveCandidate(db, id, 0)).toBe('downloading');
  });

  it('deletes intermediate source/swapped files once the job reaches ready', async () => {
    const db = getDb(':memory:');
    const id = seedJobWithFace(db);
    const sourcePath = 'media/test-cleanup/src.mp4';
    const swappedPath = 'media/test-cleanup/swapped.mp4';
    fs.mkdirSync('media/test-cleanup', { recursive: true });
    fs.writeFileSync(sourcePath, 'x');
    fs.writeFileSync(swappedPath, 'x');

    await advanceJob(db, id, okSteps); // -> awaiting_approval
    approveCandidate(db, id, 0); // -> downloading
    await advanceJob(db, id, { ...okSteps, prepareSource: async () => sourcePath }); // -> generating
    await advanceJob(db, id, { ...okSteps, generate: async () => swappedPath }); // -> processing
    await advanceJob(db, id, { ...okSteps, process: async () => 'media/test-cleanup/final.mp4' }); // -> ready

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(swappedPath)).toBe(false);
    fs.rmSync('media/test-cleanup', { recursive: true, force: true });
  });
});

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
