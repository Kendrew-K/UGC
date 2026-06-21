import Anthropic from '@anthropic-ai/sdk';

export type Classification = { type: string; industry: string; keywords: string[] };

export interface AnthropicLike {
  messages: { create(args: unknown): Promise<{ content: { type: string; text: string }[] }> };
}

const PROMPT =
  'Classify this product. Respond with ONLY minified JSON: ' +
  '{"type":"<short product type>","industry":"<industry>","keywords":["<search term>", ...]}. ' +
  'Keywords should be terms used to find viral TikTok/Reels videos of similar products.';

const SUPPORTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type MediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

/** Detect the image media type from the base64 payload's magic bytes. */
function detectMediaType(imageBase64: string): MediaType {
  // Decode just the first few bytes to inspect the file signature.
  const header = Buffer.from(imageBase64.slice(0, 24), 'base64');
  if (header[0] === 0xff && header[1] === 0xd8) return 'image/jpeg';
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'image/png';
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return 'image/gif';
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) return 'image/webp';
  // Default to JPEG; Anthropic will surface a clear error if it's something exotic (e.g. HEIC).
  return 'image/jpeg';
}

/** Pull the first JSON object out of the model's reply, tolerating ```json fences or stray prose. */
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
  return parsed;
}
