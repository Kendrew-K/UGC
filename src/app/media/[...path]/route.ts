import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
const MEDIA_ROOT = path.resolve(process.cwd(), 'media');

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const segments = (await params).path ?? [];

  // Reject path traversal
  if (segments.some((s) => s === '..' || s.includes('..') || s.includes('\0'))) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const filePath = path.join(MEDIA_ROOT, ...segments);

  // Ensure the resolved path is still inside MEDIA_ROOT
  if (!filePath.startsWith(MEDIA_ROOT + path.sep) && filePath !== MEDIA_ROOT) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: { 'Content-Type': contentType },
  });
}
