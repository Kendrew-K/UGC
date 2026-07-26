import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { advanceJob } from '@/lib/jobs';
import { buildRemakeSteps, buildPictureRemakeSteps } from '@/lib/pipeline';
import type { Classification } from '@/lib/classifier';

interface JobRow {
  product_id: number;
  face_image_path: string | null;
  media_type: string | null;
  chosen_candidate_json: string | null;
}
interface ProductRow {
  type: string;
  industry: string;
  gender: string | null;
  keywords_json: string;
  search_queries_json: string | null;
  photo_path: string | null;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(job.product_id) as ProductRow | undefined;
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 });

  const searchQueries: string[] = JSON.parse(product.search_queries_json ?? product.keywords_json ?? '[]');
  const productHint: Pick<Classification, 'type' | 'industry' | 'gender' | 'contentStyle'> = {
    type: product.type,
    industry: product.industry,
    gender: (product.gender as Classification['gender']) ?? 'unisex',
    contentStyle: 'solo-outfit',
  };

  const build = job.media_type === 'picture' ? buildPictureRemakeSteps : buildRemakeSteps;
  const steps = build({
    searchQueries,
    faceImagePath: job.face_image_path ?? '',
    productPhotoPath: product.photo_path,
    jobId,
    product: productHint,
  });
  const status = await advanceJob(db, jobId, steps);
  return NextResponse.json({ status });
}
