import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { generateAvatarOptions } from '@/lib/face';

const OPTIONS_DIR = 'media/avatar-options';

/** Generates a fresh batch of avatar options for the given prompt, for the caller to pick from. */
export async function POST(req: Request) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    // Clear stale options from a prior attempt before generating a fresh batch.
    fs.rmSync(OPTIONS_DIR, { recursive: true, force: true });
    const paths = await generateAvatarOptions(prompt, 3, OPTIONS_DIR);
    return NextResponse.json({ paths });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
