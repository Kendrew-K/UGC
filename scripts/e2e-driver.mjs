// End-to-end pipeline test driver. Creates a real product + job against the
// running dev server, approves the best clip, and drives every step to
// 'ready' (or 'failed'), logging each transition with timestamps.
// Costs real API credits (classify + try-on + one 720p WAN swap) — run on purpose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://localhost:3000';
const AUTO = new Set(['generating_face', 'queued', 'downloading', 'generating', 'processing']);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// E2E_JOB: resume driving an existing job instead of creating a new one.
// E2E_PICK: candidate index to approve; without it the driver prints the
// candidate list (with cover URLs for visual vetting) and exits, so nobody
// burns swap credits on an unseen clip.
const RESUME_JOB = process.env.E2E_JOB ? Number(process.env.E2E_JOB) : null;
const PICK = process.env.E2E_PICK ? Number(process.env.E2E_PICK) : null;
// E2E_MEDIA=picture drives the picture pipeline instead of video (both generate).
const MEDIA_TYPE = process.env.E2E_MEDIA === 'picture' ? 'picture' : 'video';

const productB64 = fs.readFileSync(path.join(os.tmpdir(), 'e2e-product.jpg')).toString('base64');
const faceB64 = fs.readFileSync('media/jobs/15/face.jpg').toString('base64');

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

let jobId;
if (RESUME_JOB) {
  jobId = RESUME_JOB;
  log('resuming job', jobId);
} else {
  log('creating product…');
  const product = await post('/api/products', { clientName: 'E2E Test', imageBase64: productB64 });
  log('product', product.productId, JSON.stringify(product.classification).slice(0, 200));

  log('creating job…');
  const jobRes = await post('/api/jobs', { productId: product.productId, count: 1, faceImageBase64: faceB64, mediaType: MEDIA_TYPE });
  jobId = jobRes.jobIds[0];
  log('job', jobId);
}

let approved = false;
let advancing = null; // status currently being advanced; never re-fire the same step
const deadline = Date.now() + 90 * 60 * 1000;

while (Date.now() < deadline) {
  const { jobs } = await (await fetch(BASE + '/api/jobs')).json();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error('job disappeared');

  if (job.status === 'ready') { log('READY:', job.output_path); break; }
  if (job.status === 'failed') { log('FAILED:', job.error); break; }
  if (job.error) log('note: job.error =', job.error);

  if (job.status === 'awaiting_approval' && !approved) {
    const candidates = JSON.parse(job.candidates_json ?? '[]');
    for (const [i, c] of candidates.entries()) {
      log(`candidate ${i}: ${c.views}v ${c.durationS ?? '?'}s score=${c.relevanceScore} ${c.url}`);
      log(`  reason: ${c.reason ?? ''}`);
      log(`  cover: ${c.coverUrl ?? ''}`);
    }
    if (candidates.length === 0) { log('FAILED: no candidates'); break; }
    if (PICK == null) { log('PAUSED: inspect covers, then rerun with E2E_JOB and E2E_PICK'); break; }
    await post(`/api/jobs/${jobId}/approve`, { chosenIndex: PICK });
    approved = true;
    advancing = null;
    log(`approved candidate ${PICK}:`, candidates[PICK].url);
  } else if (AUTO.has(job.status) && advancing !== job.status) {
    advancing = job.status;
    log('advancing from', job.status, '…');
    // fire-and-forget: long steps outlive the client's 5-min fetch timeout,
    // but the server keeps working; we watch progress via the polling GET.
    post(`/api/jobs/${jobId}/advance`).then(
      (r) => log('advance done ->', r.status),
      (e) => log('advance call ended (server may still be working):', e.message.slice(0, 200))
    );
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
log('driver finished');
