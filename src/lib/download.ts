import fs from 'node:fs';
import path from 'node:path';

/**
 * Copies or downloads a source (local path or http(s) URL) to `destPath`.
 *
 * - If `urlOrPath` is a local filesystem path (no http/https scheme), the
 *   file is copied to `destPath` and the source file is removed.
 * - Otherwise, `urlOrPath` is fetched over HTTP and the response body is
 *   written to `destPath`.
 */
export async function downloadTo(
  urlOrPath: string,
  destPath: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<string> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (!/^https?:\/\//i.test(urlOrPath)) {
    fs.copyFileSync(urlOrPath, destPath);
    fs.rmSync(urlOrPath, { force: true });
    return destPath;
  }

  const f = deps.fetchImpl ?? fetch;
  const res = await f(urlOrPath);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}
