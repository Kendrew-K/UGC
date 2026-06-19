import { describe, it, expect } from 'vitest';
import { classifyProduct } from './classifier';

const fakeClient = {
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: '{"type":"makeup","industry":"beauty","keywords":["makeup","foundation"]}' }],
    }),
  },
};

describe('classifyProduct', () => {
  it('parses Claude JSON into a Classification', async () => {
    const result = await classifyProduct('BASE64', { client: fakeClient });
    expect(result).toEqual({ type: 'makeup', industry: 'beauty', keywords: ['makeup', 'foundation'] });
  });

  it('throws on unparseable model output', async () => {
    const bad = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json' }] }) } };
    await expect(classifyProduct('BASE64', { client: bad })).rejects.toThrow();
  });
});
