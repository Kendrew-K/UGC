/**
 * Iterative eval loop: classify a product, scrape mock candidates, score with Claude,
 * adjust keyword strategy if quality is low, repeat up to MAX_TURNS times.
 * Documents every turn to brainstorms/2026-06-21-eval-loop.md.
 *
 * Run: npx tsx scripts/eval-loop.ts
 */

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { rankCandidates } from '../src/lib/evaluator';
import type { Classification } from '../src/lib/classifier';
import type { Candidate } from '../src/lib/scraper';

const MAX_TURNS = 7;
const SATISFACTION_THRESHOLD = 7; // avg relevance score to stop early
const LOG_FILE = 'brainstorms/2026-06-21-eval-loop.md';

// ─── Test scenarios ────────────────────────────────────────────────────────────

type Scenario = {
  name: string;
  description: string; // what would be in the photo
  expectedGender: 'male' | 'female' | 'unisex';
};

const SCENARIOS: Scenario[] = [
  { name: "Men's leather jacket", description: 'a brown men\'s leather biker jacket on a hanger', expectedGender: 'male' },
  { name: "Women's skincare serum", description: 'a glass dropper bottle of vitamin C face serum', expectedGender: 'female' },
  { name: 'Unisex white sneakers', description: 'a pair of clean white minimalist sneakers', expectedGender: 'unisex' },
  { name: "Women's floral dress", description: 'a floral midi dress in pastel pink on a white background', expectedGender: 'female' },
];

// ─── Mock candidates (realistic mix of relevant + irrelevant) ──────────────────

function mockCandidatesFor(scenario: Scenario): Candidate[] {
  const g = scenario.expectedGender;
  const isSkincare = scenario.name.toLowerCase().includes('serum') || scenario.name.toLowerCase().includes('skincare');

  if (isSkincare) {
    return [
      // Relevant — single person skincare routine
      {
        url: 'https://tiktok.com/v/1', views: 4_800_000, downloadUrl: 'http://dl/1.mp4', hasVoice: false, platform: 'tiktok',
        title: 'my morning skincare routine vitamin c serum glow',
        hashtags: ['skincareroutine', 'vitaminc', 'glowingskin', 'skincare'],
      },
      // Relevant — product demo
      {
        url: 'https://tiktok.com/v/2', views: 2_900_000, downloadUrl: 'http://dl/2.mp4', hasVoice: false, platform: 'tiktok',
        title: 'vitamin c serum before and after results one month',
        hashtags: ['beforeandafter', 'vitaminc', 'serumreview', 'skintransformation'],
      },
      // Wrong product — hair serum not face serum
      {
        url: 'https://tiktok.com/v/3', views: 6_000_000, downloadUrl: 'http://dl/3.mp4', hasVoice: false, platform: 'tiktok',
        title: 'hair serum routine for frizzy hair transformation',
        hashtags: ['haircare', 'hairserum', 'hairtransformation'],
      },
      // Compilation — 10 skincare products review
      {
        url: 'https://tiktok.com/v/4', views: 9_000_000, downloadUrl: 'http://dl/4.mp4', hasVoice: false, platform: 'tiktok',
        title: '10 skincare products I tried this month haul review',
        hashtags: ['skincarhaul', 'productreview', 'skincare10products'],
      },
      // Completely irrelevant
      {
        url: 'https://tiktok.com/v/5', views: 1_500_000, downloadUrl: 'http://dl/5.mp4', hasVoice: false, platform: 'tiktok',
        title: 'what I eat in a day anti inflammatory diet',
        hashtags: ['nutrition', 'antiinflammatory', 'cleaneating'],
      },
      // Borderline — right product but group/talking head format
      {
        url: 'https://tiktok.com/v/6', views: 3_200_000, downloadUrl: 'http://dl/6.mp4', hasVoice: false, platform: 'tiktok',
        title: 'dermatologist reacts to vitamin c serum ingredients',
        hashtags: ['derm', 'skincarescience', 'vitaminc', 'reacts'],
      },
    ];
  }

  // Fashion / footwear scenarios
  return [
    // Relevant — solo fit check correct gender
    {
      url: 'https://tiktok.com/v/1', views: 5_200_000, downloadUrl: 'http://dl/1.mp4', hasVoice: false, platform: 'tiktok',
      title: `${g === 'male' ? 'men' : g === 'female' ? 'women' : ''} fit check ${scenario.name.toLowerCase()}`,
      hashtags: ['fitcheck', 'OOTD', g === 'male' ? 'mensfashion' : 'womensfashion'],
    },
    // Relevant — solo styling
    {
      url: 'https://tiktok.com/v/2', views: 3_100_000, downloadUrl: 'http://dl/2.mp4', hasVoice: false, platform: 'tiktok',
      title: `styling my new ${scenario.name.toLowerCase()} outfit of the day`,
      hashtags: ['styling', 'outfitoftheday', 'fashion'],
    },
    // Wrong gender
    {
      url: 'https://tiktok.com/v/3', views: 8_000_000, downloadUrl: 'http://dl/3.mp4', hasVoice: false, platform: 'tiktok',
      title: g === 'male' ? 'women haul 50 outfits try on' : 'men streetwear haul 2024',
      hashtags: [g === 'male' ? 'girlsfashion' : 'streetwear', 'haul', 'tryonhaul'],
    },
    // Multi-outfit compilation
    {
      url: 'https://tiktok.com/v/4', views: 12_000_000, downloadUrl: 'http://dl/4.mp4', hasVoice: false, platform: 'tiktok',
      title: '50 outfit ideas for the week compilation lookbook',
      hashtags: ['lookbook', 'outfitideas', 'compilation', 'weeklyoutfits'],
    },
    // Completely irrelevant
    {
      url: 'https://tiktok.com/v/5', views: 2_000_000, downloadUrl: 'http://dl/5.mp4', hasVoice: false, platform: 'tiktok',
      title: 'what I eat in a day healthy meal prep',
      hashtags: ['mealprep', 'healthyfood', 'nutrition'],
    },
    // Borderline — right category but group video
    {
      url: 'https://tiktok.com/v/6', views: 4_500_000, downloadUrl: 'http://dl/6.mp4', hasVoice: false, platform: 'tiktok',
      title: `friends fashion ${scenario.name.toLowerCase()} group lookbook`,
      hashtags: ['groupfit', 'fashionfriends', 'lookbook'],
    },
  ];
}

// ─── Claude-powered classification from text description ──────────────────────

async function classifyFromDescription(client: Anthropic, scenario: Scenario): Promise<Classification> {
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content:
        `A client uploaded a product photo showing: ${scenario.description}.\n` +
        `Classify this product and generate targeted TikTok search queries.\n` +
        `Respond ONLY with minified JSON:\n` +
        `{"type":"<short type>","industry":"<industry>","gender":"<male|female|unisex>",` +
        `"contentStyle":"<solo-outfit|beauty-routine|product-demo|lifestyle>",` +
        `"keywords":["<raw>",...],"searchQueries":["<specific TikTok phrase>",...]}\n` +
        `searchQueries: 3–5 phrases to find viral SINGLE-PERSON clips showcasing this product. ` +
        `Match correct gender. Avoid multi-outfit compilations. Use "fit check", "OOTD", "styling".`,
    }],
  });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  const parsed = JSON.parse(text.slice(start, end + 1)) as Classification;
  parsed.gender = parsed.gender ?? 'unisex';
  parsed.contentStyle = parsed.contentStyle ?? 'solo-outfit';
  parsed.searchQueries = Array.isArray(parsed.searchQueries) && parsed.searchQueries.length > 0
    ? parsed.searchQueries : parsed.keywords;
  return parsed;
}

// ─── Keyword refinement when scores are low ───────────────────────────────────

async function refineKeywords(
  client: Anthropic,
  scenario: Scenario,
  prev: Classification,
  avgScore: number,
  lowScoredReasons: string[]
): Promise<string[]> {
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content:
        `Product: ${scenario.name} (${prev.gender}).\n` +
        `Previous search queries: ${JSON.stringify(prev.searchQueries)}\n` +
        `Average relevance score: ${avgScore.toFixed(1)}/10.\n` +
        `Problems found: ${lowScoredReasons.slice(0, 3).join('; ')}\n\n` +
        `Generate 4 improved TikTok search queries that avoid the above problems. ` +
        `More specific, correct gender, single-person showcase only.\n` +
        `Respond ONLY with a JSON array of strings: ["query1","query2",...]`,
    }],
  });
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const start = text.indexOf('['); const end = text.lastIndexOf(']');
  return JSON.parse(text.slice(start, end + 1)) as string[];
}

// ─── Log to brainstorm file ────────────────────────────────────────────────────

function log(text: string) {
  fs.appendFileSync(LOG_FILE, text + '\n');
  process.stdout.write(text + '\n');
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic();

  log('\n---\n## Eval Loop Run — ' + new Date().toISOString());

  for (const scenario of SCENARIOS) {
    log(`\n### Scenario: ${scenario.name}`);
    let classification = await classifyFromDescription(client, scenario);
    const candidates = mockCandidatesFor(scenario);

    let turn = 0;
    let avgScore = 0;

    while (turn < MAX_TURNS) {
      turn++;
      log(`\n#### Turn ${turn}`);
      log(`Search queries: ${JSON.stringify(classification.searchQueries)}`);

      const scored = await rankCandidates(classification, candidates, { client });
      avgScore = scored.length > 0
        ? scored.reduce((s, c) => s + c.relevanceScore, 0) / scored.length
        : 0;

      log(`Candidates after filter: ${scored.length}/${candidates.length}`);
      log(`Average relevance score: ${avgScore.toFixed(1)}/10`);
      scored.forEach((c, i) => log(`  ${i + 1}. [${c.relevanceScore}/10] "${c.title}" — ${c.reason}`));

      if (avgScore >= SATISFACTION_THRESHOLD) {
        log(`✅ Satisfied at turn ${turn} (avg ${avgScore.toFixed(1)} ≥ ${SATISFACTION_THRESHOLD})`);
        break;
      }

      if (turn === MAX_TURNS) {
        log(`⚠️ Max turns reached. Final avg score: ${avgScore.toFixed(1)}`);
        break;
      }

      log(`Score below threshold — refining keywords…`);
      const lowReasons = scored
        .filter((c) => c.relevanceScore < SATISFACTION_THRESHOLD)
        .map((c) => c.reason);
      const refined = await refineKeywords(client, scenario, classification, avgScore, lowReasons);
      classification = { ...classification, searchQueries: refined };
    }

    log(`\n**Final result for "${scenario.name}":** avg ${avgScore.toFixed(1)}/10 after ${turn} turn(s)`);
    log(`Final queries: ${JSON.stringify(classification.searchQueries)}`);
  }

  log('\n## Eval loop complete');
}

main().catch((err) => { console.error(err); process.exit(1); });
