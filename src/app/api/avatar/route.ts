import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSavedAvatarPath, clearSavedAvatar } from '@/lib/avatar';

/** Returns the currently saved avatar's path, or null if none has been chosen yet. */
export async function GET() {
  const db = getDb();
  return NextResponse.json({ path: getSavedAvatarPath(db) });
}

/** Clears the saved avatar so the picker flow can run again. */
export async function DELETE() {
  const db = getDb();
  clearSavedAvatar(db);
  return NextResponse.json({ cleared: true });
}
