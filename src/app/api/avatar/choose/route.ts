import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { saveAvatarChoice } from '@/lib/avatar';

const OPTIONS_DIR = 'media/avatar-options';

/** Saves the chosen avatar option as the canonical avatar and discards the rest. */
export async function POST(req: Request) {
  try {
    const { chosenPath } = (await req.json()) as { chosenPath?: string };
    if (!chosenPath) return NextResponse.json({ error: 'chosenPath is required' }, { status: 400 });
    const db = getDb();
    const path = saveAvatarChoice(db, chosenPath);
    // Best-effort: remove the option files now that one has been chosen and copied out.
    fs.rmSync(OPTIONS_DIR, { recursive: true, force: true });
    return NextResponse.json({ path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
