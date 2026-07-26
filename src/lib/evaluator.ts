import Anthropic from '@anthropic-ai/sdk';
import type { Classification } from './classifier';
import type { Candidate } from './scraper';

export type ScoredCandidate = Candidate & { relevanceScore: number; reason: string };

const MIN_SCORE = 3;

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** Score and filter candidates for relevance to the product using Claude. */
export async function rankCandidates(
  product: Classification,
  candidates: Candidate[],
  deps: { client?: Anthropic } = {}
): Promise<ScoredCandidate[]> {
  if (candidates.length === 0) return [];

  const client = deps.client ?? new Anthropic();

  const header =
    `Product: ${product.type} | gender: ${product.gender} | style: ${product.contentStyle} | industry: ${product.industry}\n\n` +
    `Rate each TikTok/Reels clip as CREATIVE REFERENCE for making a new ${product.industry} video with a different AI person. Score 0-10.\n` +
    `Match at INDUSTRY/ACTIVITY level, not exact product: any viral ${product.industry} clip showing the right activity is a strong reference even if the exact item differs.\n` +
    `10 = a person doing appealing, imitable ${product.industry} actions on the right gender.\n` +
    `Score 0-2 (hard reject) ONLY for: collage/grid layouts, multi-clip compilations, or no person visible.\n` +
    `Mirrors, second people, occlusion and busy backgrounds are all fine — nothing is reused but the ideas.\n` +
    `Deduct for wrong gender. Judge format from the thumbnail; titles routinely lie.\n`;

  // Interleave each clip's metadata with its cover thumbnail so scoring sees
  // the actual video format — titles/tags can't reveal a compilation collage.
  const blocks: Anthropic.ContentBlockParam[] = [{ type: 'text', text: header }];
  for (const [i, c] of candidates.entries()) {
    const tags = (c.hashtags ?? []).map((h) => `#${h}`).join(' ');
    blocks.push({ type: 'text', text: `${i}. title="${c.title ?? ''}" tags="${tags}" views=${c.views}` });
    if (c.coverUrl) blocks.push({ type: 'image', source: { type: 'url', url: c.coverUrl } });
  }
  blocks.push({
    type: 'text',
    text: 'Respond ONLY with minified JSON array: [{"index":0,"score":8,"reason":"<one line>"},...]',
  });

  const request = (content: Anthropic.ContentBlockParam[]) =>
    client.messages.create({ model: 'claude-opus-4-8', max_tokens: 1024, messages: [{ role: 'user', content }] });

  let res: Anthropic.Message;
  try {
    res = await request(blocks);
  } catch {
    // Cover URLs are signed and expire; if any image fetch breaks the call,
    // fall back to text-only scoring rather than failing the whole job.
    res = await request(blocks.filter((b) => b.type === 'text'));
  }

  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  let scores: Array<{ index: number; score: number; reason: string }>;
  try {
    scores = JSON.parse(extractJson(text));
  } catch {
    // If Claude's response can't be parsed, pass all candidates through unscored.
    return candidates.map((c) => ({ ...c, relevanceScore: 5, reason: 'unscored' }));
  }

  return candidates
    .map((c, i) => {
      const s = scores.find((x) => x.index === i);
      return { ...c, relevanceScore: s?.score ?? 0, reason: s?.reason ?? '' };
    })
    .filter((c) => c.relevanceScore >= MIN_SCORE)
    .sort((a, b) => b.relevanceScore * Math.log(b.views + 1) - a.relevanceScore * Math.log(a.views + 1));
}
