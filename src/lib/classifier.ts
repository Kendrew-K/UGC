import Anthropic from '@anthropic-ai/sdk';

export type Classification = { type: string; industry: string; keywords: string[] };

export interface AnthropicLike {
  messages: { create(args: unknown): Promise<{ content: { type: string; text: string }[] }> };
}

const PROMPT =
  'Classify this product. Respond with ONLY minified JSON: ' +
  '{"type":"<short product type>","industry":"<industry>","keywords":["<search term>", ...]}. ' +
  'Keywords should be terms used to find viral TikTok/Reels videos of similar products.';

export async function classifyProduct(
  imageBase64: string,
  deps: { client?: AnthropicLike } = {}
): Promise<Classification> {
  const client = deps.client ?? (new Anthropic() as unknown as AnthropicLike);
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text) as Classification;
  if (!parsed.type || !Array.isArray(parsed.keywords)) throw new Error('Invalid classification shape');
  return parsed;
}
