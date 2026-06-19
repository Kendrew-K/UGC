import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { downloadTo } from './download';

const tmp = 'media/test-out/sample.bin';
afterEach(() => fs.rmSync('media/test-out', { recursive: true, force: true }));

describe('downloadTo', () => {
  it('writes fetched bytes to disk and returns the path', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    const out = await downloadTo('http://x/y', tmp, { fetchImpl });
    expect(out).toBe(tmp);
    expect(fs.readFileSync(tmp)).toEqual(Buffer.from([1, 2, 3]));
  });
});
