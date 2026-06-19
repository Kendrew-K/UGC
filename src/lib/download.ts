import fs from 'node:fs';
import path from 'node:path';

export async function downloadTo(
  url: string,
  destPath: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return destPath;
}
