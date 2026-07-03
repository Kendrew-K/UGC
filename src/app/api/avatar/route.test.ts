import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `ugc-avatar-test-${Date.now()}.sqlite`);

beforeAll(() => { process.env.UGC_DB_PATH = tmpDb; });
afterAll(() => {
  try { fs.unlinkSync(tmpDb); } catch {}
  delete process.env.UGC_DB_PATH;
});

import { GET, DELETE } from './route';
import { POST as choose } from './choose/route';

describe('avatar route', () => {
  it('returns null path when nothing saved yet', async () => {
    const res = await (await GET()).json();
    expect(res.path).toBeNull();
  });

  it('reflects a saved choice, then clears it', async () => {
    fs.mkdirSync('media/avatar-options', { recursive: true });
    fs.writeFileSync('media/avatar-options/option-0.jpg', 'fake');
    const chooseReq = new Request('http://localhost/api/avatar/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenPath: 'media/avatar-options/option-0.jpg' }),
    });
    const chosen = await (await choose(chooseReq)).json();
    expect(chosen.path).toBe('media/avatar.jpg');

    const got = await (await GET()).json();
    expect(got.path).toBe('media/avatar.jpg');

    const cleared = await (await DELETE()).json();
    expect(cleared.cleared).toBe(true);
    const gotAfter = await (await GET()).json();
    expect(gotAfter.path).toBeNull();

    fs.rmSync('media/avatar-options', { recursive: true, force: true });
    fs.rmSync('media/avatar.jpg', { force: true });
  });
});
