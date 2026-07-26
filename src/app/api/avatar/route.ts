import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSavedAvatarPath, clearSavedAvatar, listAvatars } from '@/lib/avatar';

/** Returns the default avatar's path plus every saved avatar the client can pick from.
 * The recorded default can dangle (file deleted outside the app), so fall back
 * to the newest avatar that actually exists on disk. */
export async function GET() {
  const db = getDb();
  const all = listAvatars(db);
  const current = getSavedAvatarPath(db);
  const path = current && all.includes(current) ? current : (all[0] ?? null);
  return NextResponse.json({ path, all });
}

/** Clears the saved avatar so the picker flow can run again. */
export async function DELETE() {
  const db = getDb();
  clearSavedAvatar(db);
  return NextResponse.json({ cleared: true });
}
