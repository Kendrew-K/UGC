/**
 * Server-less end-to-end job driver. Drives one video remake job from scrape
 * to a finished clip by calling the pipeline state machine directly (no HTTP
 * server, no dev process). Auto-approves the top-ranked candidate and, on a
 * download/QC bounce, falls through to the next-best candidate automatically.
 *
 * Run: npx tsx scripts/run-job.ts
 * Env: reads .env itself (product/face come from an existing DB row).
 * Costs real credits (scrape + describe + dress + one Kling i2v roll).
 */
import fs from 'node:fs';
import path from 'node:path';

// Load .env before importing any lib module — several read process.env at
// import time (scraper's PYTHON_BIN, etc.), so this must run first, which is
// why the lib imports below are dynamic (ESM evaluates static imports first).
// Uses the stdlib loader: it handles CRLF line endings, which a naive
// split('\n') + regex does not (a trailing \r breaks the `$` anchor).
process.loadEnvFile('.env');

const PRODUCT_ID = Number(process.env.RUN_PRODUCT_ID ?? 133);
const FACE_SRC = process.env.RUN_FACE_SRC ?? 'media/jobs/36/face.jpg';

const ts = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(ts(), ...a);

// Wrapped in an async IIFE (not top-level await): tsx compiles .ts as CJS,
// which rejects top-level await. Dynamic imports still run after the .env
// loader above, which is the ordering that matters.
main().catch((err) => { console.error(err); process.exit(1); });

async function main() {
const { getDb } = await import('../src/lib/db');
const { createJob, advanceJob, approveCandidate } = await import('../src/lib/jobs');
const { buildRemakeSteps } = await import('../src/lib/pipeline');

const db = getDb();

const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(PRODUCT_ID) as
  | { id: number; type: string; industry: string; gender: string; photo_path: string; search_queries_json: string | null; keywords_json: string | null }
  | undefined;
if (!prod) throw new Error(`product ${PRODUCT_ID} not found`);
if (!fs.existsSync(FACE_SRC)) throw new Error(`face image not found: ${FACE_SRC}`);

const searchQueries: string[] = JSON.parse(prod.search_queries_json ?? prod.keywords_json ?? '[]');
if (searchQueries.length === 0) throw new Error(`product ${PRODUCT_ID} has no search queries`);

// Fresh job, pre-seeded with a face so it starts at the scrape step (skips
// AI avatar generation — we want to exercise fetch → download → generate).
const jobId = createJob(db, PRODUCT_ID, { mediaType: 'video', status: 'queued' });
const jobDir = `media/jobs/${jobId}`;
fs.mkdirSync(jobDir, { recursive: true });
const facePath = path.join(jobDir, 'face.jpg');
fs.copyFileSync(FACE_SRC, facePath);
db.prepare('UPDATE jobs SET face_image_path = ? WHERE id = ?').run(facePath, jobId);

log(`job ${jobId} created — product ${PRODUCT_ID} (${prod.type}, ${prod.gender})`);
log('search queries:', JSON.stringify(searchQueries));

const steps = buildRemakeSteps({
  searchQueries,
  faceImagePath: facePath,
  productPhotoPath: prod.photo_path,
  jobId,
  product: { type: prod.type, industry: prod.industry, gender: prod.gender as never, contentStyle: 'solo-outfit' },
});

const tried = new Set<number>();
const getJob = () => db.prepare('SELECT status, error, candidates_json, output_path FROM jobs WHERE id = ?').get(jobId) as
  { status: string; error: string | null; candidates_json: string | null; output_path: string | null };

let guard = 0;
while (guard++ < 40) {
  const job = getJob();

  if (job.status === 'ready') { log('✅ READY:', job.output_path); break; }
  if (job.status === 'failed') { log('❌ FAILED:', job.error); break; }

  if (job.status === 'awaiting_approval') {
    if (job.error) log('note (bounced back):', job.error);
    const candidates = JSON.parse(job.candidates_json ?? '[]') as Array<{ url: string; views: number; relevanceScore?: number; durationS?: number }>;
    if (candidates.length === 0) { log('❌ no candidates surfaced'); break; }
    // Candidates arrive ranked best-first; take the best not-yet-tried one.
    const pick = candidates.findIndex((_, i) => !tried.has(i));
    if (pick === -1) { log('❌ every candidate exhausted (all bounced)'); break; }
    tried.add(pick);
    const c = candidates[pick];
    log(`approving candidate ${pick}: ${c.views}v score=${c.relevanceScore} ${c.durationS ?? '?'}s ${c.url}`);
    approveCandidate(db, jobId, pick);
    continue;
  }

  log('advancing from', job.status, '…');
  const next = await advanceJob(db, jobId, steps);
  log('  ->', next);
}

if (guard >= 40) log('❌ step guard tripped (loop bound)');
log('driver finished');
}
