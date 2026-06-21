import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { createJob } from '@/lib/jobs';
import { saveMemory } from '@/lib/memory';

export async function GET() {
  const db = getDb();
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  return NextResponse.json({ jobs });
}

/** Persist an uploaded face photo for a job and return its local path. */
function saveFace(jobId: number, faceImageBase64: string): string {
  const dir = path.join('media', 'jobs', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'face.jpg');
  fs.writeFileSync(dest, Buffer.from(faceImageBase64, 'base64'));
  return dest;
}

export async function POST(req: Request) {
  try {
    const { productId, count, answers, faceImageBase64, facePrompt } = (await req.json()) as {
      productId: number;
      count?: number;
      answers?: Record<string, unknown>;
      faceImageBase64?: string;
      facePrompt?: string;
    };
    if (!faceImageBase64 && !facePrompt) {
      return NextResponse.json({ error: 'A face photo or avatar prompt is required' }, { status: 400 });
    }
    const db = getDb();
    const product = db.prepare('SELECT type FROM products WHERE id = ?').get(productId) as { type: string } | undefined;
    if (product && answers) saveMemory(db, product.type, answers);
    const jobIds = Array.from({ length: count ?? 1 }, () => {
      if (faceImageBase64) {
        const jobId = createJob(db, productId);
        const facePath = saveFace(jobId, faceImageBase64);
        db.prepare("UPDATE jobs SET face_image_path = ?, updated_at = datetime('now') WHERE id = ?").run(facePath, jobId);
        return jobId;
      }
      // Avatar will be generated during the generating_face pipeline step.
      return createJob(db, productId, { status: 'generating_face', facePrompt: facePrompt! });
    });
    return NextResponse.json({ jobIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/jobs] create failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
