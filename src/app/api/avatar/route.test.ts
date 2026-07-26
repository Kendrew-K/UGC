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
  it('returns a library member as the default path, or null when the library is empty', async () => {
    // This suite runs against the real media/ dir, which may already hold the
    // user's avatars — assert the invariant rather than a specific value.
    const res = await (await GET()).json();
    if (res.all.length === 0) {
      expect(res.path).toBeNull();
    } else {
      expect(res.all).toContain(res.path);
    }
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
    expect(chosen.path).toMatch(/^media\/avatars\/avatar-\d+\.jpg$/);

    const got = await (await GET()).json();
    expect(got.path).toBe(chosen.path);
    expect(got.all).toContain(chosen.path);

    const cleared = await (await DELETE()).json();
    expect(cleared.cleared).toBe(true);

    // Remove the library file first: GET falls back to any avatar still on disk.
    fs.rmSync('media/avatar-options', { recursive: true, force: true });
    fs.rmSync(chosen.path, { force: true });
    // The library may hold the user's real avatars (this suite runs against
    // the real media/ dir), so only assert the test's own file is gone.
    const gotAfter = await (await GET()).json();
    expect(gotAfter.all).not.toContain(chosen.path);
    expect(gotAfter.path).not.toBe(chosen.path);
  });
});
