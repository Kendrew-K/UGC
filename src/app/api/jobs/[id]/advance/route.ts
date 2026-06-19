import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { advanceJob } from '@/lib/jobs';
import { buildSteps } from '@/lib/pipeline';
import { resolveFace, type FaceSpec } from '@/lib/face';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as any;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(job.product_id) as any;
  const keywords = JSON.parse(product.keywords_json ?? '[]');
  const body = (await req.json().catch(() => ({}))) as { faceSource?: FaceSpec };
  const faceImagePath = body.faceSource
    ? await resolveFace(body.faceSource, `media/jobs/${jobId}/face.jpg`)
    : (job.face_image_path ?? 'media/jobs/' + jobId + '/face.jpg');
  const steps = buildSteps({ keywords, faceImagePath, jobId });
  const status = await advanceJob(db, jobId, steps);
  return NextResponse.json({ status });
}
