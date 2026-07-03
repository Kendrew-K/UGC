import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/face', () => ({
  generateAvatarOptions: async (prompt: string, count: number, destDir: string) =>
    Array.from({ length: count }, (_, i) => `${destDir}/option-${i}.jpg`),
}));

import { POST } from './route';

describe('avatar generate route', () => {
  it('returns 3 generated option paths', async () => {
    const req = new Request('http://localhost/api/avatar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'young woman, studio lighting' }),
    });
    const res = await (await POST(req)).json();
    expect(res.paths).toHaveLength(3);
    expect(res.paths[0]).toContain('option-0.jpg');
  });

  it('rejects a missing prompt', async () => {
    const req = new Request('http://localhost/api/avatar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });
});
