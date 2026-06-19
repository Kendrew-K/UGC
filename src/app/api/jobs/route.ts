import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createJob } from '@/lib/jobs';
import { saveMemory } from '@/lib/memory';

export async function GET() {
  const db = getDb();
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  // Face source is supplied per-advance via POST /api/jobs/{id}/advance
  const { productId, count, answers } = (await req.json()) as {
    productId: number; count: number; answers?: Record<string, unknown>;
  };
  const db = getDb();
  const product = db.prepare('SELECT type FROM products WHERE id = ?').get(productId) as { type: string } | undefined;
  if (product && answers) saveMemory(db, product.type, answers);
  const jobIds = Array.from({ length: count }, () => createJob(db, productId));
  return NextResponse.json({ jobIds });
}
