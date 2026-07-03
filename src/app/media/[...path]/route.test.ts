import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { GET } from './route';

const dir = 'media/route-test';
const file = `${dir}/sample.mp4`;

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function req(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) } as unknown as Parameters<typeof GET>[0];
}

describe('media route Range support', () => {
  it('returns the full file with 200 when no Range header is sent', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4]));
    const res = await GET(req(), { params: Promise.resolve({ path: ['route-test', 'sample.mp4'] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3, 4]));
  });

  it('returns a 206 partial response honoring the Range header', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4]));
    const res = await GET(req({ range: 'bytes=1-3' }), { params: Promise.resolve({ path: ['route-test', 'sample.mp4'] }) });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 1-3/5');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });
});
