import { describe, it, expect } from 'vitest';
import { classifyProduct } from './classifier';

const fakeClient = {
  messages: {
    create: async () => ({
      content: [{
        type: 'text',
        text: '{"type":"makeup","industry":"beauty","gender":"female","contentStyle":"beauty-routine","keywords":["makeup","foundation"],"searchQueries":["women foundation tutorial","female makeup OOTD"]}',
      }],
    }),
  },
};

describe('classifyProduct', () => {
  it('parses Claude JSON into a Classification with gender and searchQueries', async () => {
    const result = await classifyProduct('BASE64', { client: fakeClient });
    expect(result.type).toBe('makeup');
    expect(result.industry).toBe('beauty');
    expect(result.gender).toBe('female');
    expect(result.contentStyle).toBe('beauty-routine');
    expect(result.keywords).toEqual(['makeup', 'foundation']);
    expect(result.searchQueries).toEqual(['women foundation tutorial', 'female makeup OOTD']);
  });

  it('backfills gender and searchQueries when missing from response', async () => {
    const minimal = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"type":"jacket","industry":"fashion","keywords":["jacket"]}' }],
        }),
      },
    };
    const result = await classifyProduct('BASE64', { client: minimal });
    expect(result.gender).toBe('unisex');
    expect(result.searchQueries).toEqual(['jacket']);
  });

  it('throws on unparseable model output', async () => {
    const bad = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json' }] }) } };
    await expect(classifyProduct('BASE64', { client: bad })).rejects.toThrow();
  });
});
