import Anthropic from '@anthropic-ai/sdk';
import type { Classification } from './classifier';
import type { Candidate } from './scraper';

export type ScoredCandidate = Candidate & { relevanceScore: number; reason: string };

const MIN_SCORE = 4;

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

  const list = candidates
    .map((c, i) => {
      const tags = (c.hashtags ?? []).map((h) => `#${h}`).join(' ');
      return `${i}. title="${c.title ?? ''}" tags="${tags}" views=${c.views}`;
    })
    .join('\n');

  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          `Product: ${product.type} | gender: ${product.gender} | style: ${product.contentStyle} | industry: ${product.industry}\n\n` +
          `Rate each TikTok/Reels clip as a UGC background for this product. Score 0–10.\n` +
          `10 = single person, correct gender, showcasing exactly this product type.\n` +
          `Deduct for: wrong gender, multi-outfit compilation, group video, no visible product.\n\n` +
          `Clips:\n${list}\n\n` +
          `Respond ONLY with minified JSON array: [{"index":0,"score":8,"reason":"<one line>"},...]`,
      },
    ],
  });

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
