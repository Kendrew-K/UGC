import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { approveCandidate } from '@/lib/jobs';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const jobId = Number(id);
    const { chosenIndex } = (await req.json()) as { chosenIndex: number };
    const db = getDb();
    const status = approveCandidate(db, jobId, chosenIndex);
    return NextResponse.json({ status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
