import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { advanceJob } from '@/lib/jobs';
import { buildSteps } from '@/lib/pipeline';

interface JobRow { product_id: number; face_image_path: string | null }
interface ProductRow { type: string; keywords_json: string }

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(job.product_id) as ProductRow | undefined;
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 });
  const keywords = JSON.parse(product.keywords_json ?? '[]');
  const steps = buildSteps({ keywords, faceImagePath: job.face_image_path ?? '', jobId });
  const status = await advanceJob(db, jobId, steps);
  return NextResponse.json({ status });
}
