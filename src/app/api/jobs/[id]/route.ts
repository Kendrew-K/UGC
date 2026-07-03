import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { renameJob, deleteJob } from '@/lib/jobs';

/** Renames a job (client-chosen display name). Body: `{ name: string }`. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { name } = (await req.json()) as { name: string };
    const db = getDb();
    renameJob(db, Number(id), name);
    return NextResponse.json({ name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Deletes a job and its media directory (best-effort media cleanup). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    deleteJob(db, Number(id));
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
