import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/classifier', () => ({
  classifyProduct: async () => ({ type: 'makeup', industry: 'beauty', keywords: ['makeup'] }),
}));

import { POST } from './route';

describe('POST /api/products', () => {
  it('returns classification and memory flag', async () => {
    const req = new Request('http://localhost/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientName: 'Acme', imageBase64: 'AAAA' }),
    });
    const res = await POST(req);
    const json = await res.json();
    expect(json.classification.type).toBe('makeup');
    expect(json).toHaveProperty('remembered'); // null first time
  });
});
