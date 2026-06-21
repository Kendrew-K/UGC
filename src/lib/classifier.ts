import Anthropic from '@anthropic-ai/sdk';

export type Classification = {
  type: string;
  industry: string;
  gender: 'male' | 'female' | 'unisex';
  contentStyle: 'solo-outfit' | 'beauty-routine' | 'product-demo' | 'lifestyle';
  keywords: string[];
  searchQueries: string[];
};

export interface AnthropicLike {
  messages: { create(args: unknown): Promise<{ content: { type: string; text: string }[] }> };
}

const PROMPT =
  'Classify this product photo. Respond ONLY with minified JSON:\n' +
  '{"type":"<short product type>","industry":"<industry>",' +
  '"gender":"<male|female|unisex>","contentStyle":"<solo-outfit|beauty-routine|product-demo|lifestyle>",' +
  '"keywords":["<raw keyword>",...],"searchQueries":["<specific TikTok search phrase>",...]}\n\n' +
  'Rules for searchQueries (3–5 phrases):\n' +
  '- Target viral SINGLE-PERSON TikTok/Reels videos showcasing THIS exact product type\n' +
  '- Match the correct gender (e.g. "men" or "women" prefix for gendered products)\n' +
  '- Avoid compilation/multi-outfit content — prefer "fit check", "OOTD", "outfit of the day", "styling"\n' +
  '- Be specific to the item — e.g. men\'s leather jacket → ["men fit check leather jacket","male OOTD jacket outfit","men leather jacket styling"]';

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type MediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

function detectMediaType(imageBase64: string): MediaType {
  const header = Buffer.from(imageBase64.slice(0, 24), 'base64');
  if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'image/png';
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return 'image/gif';
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) return 'image/webp';
  return 'image/jpeg';
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

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
          { type: 'image', source: { type: 'base64', media_type: detectMediaType(imageBase64), data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  let parsed: Classification;
  try {
    parsed = JSON.parse(extractJson(text)) as Classification;
  } catch {
    throw new Error(`Classifier did not return valid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.type || !Array.isArray(parsed.keywords)) throw new Error('Invalid classification shape');
  // Backfill missing fields for resilience
  parsed.gender = parsed.gender ?? 'unisex';
  parsed.contentStyle = parsed.contentStyle ?? 'solo-outfit';
  parsed.searchQueries = Array.isArray(parsed.searchQueries) && parsed.searchQueries.length > 0
    ? parsed.searchQueries
    : parsed.keywords;
  return parsed;
}
