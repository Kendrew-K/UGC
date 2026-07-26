import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  describeReferenceVideo,
  buildGenerationPrompt,
  describeReferencePhoto,
  buildPhotoPrompt,
  type VideoBrief,
  type PhotoBrief,
} from './describe';

const validBrief = {
  summary: 'Woman walks toward camera on a city sidewalk showing off a leather jacket.',
  subject: { description: 'young woman, long curly dark hair', outfitStyle: 'oversized black leather jacket, striped crop top, light wide-leg jeans' },
  beats: [
    { t: '0s', action: 'walks slowly toward camera' },
    { t: '1s', action: 'hands in pockets' },
    { t: '3s', action: 'turns to show jacket back' },
  ],
  scene: { setting: 'downtown sidewalk beside glass storefronts', timeOfDay: 'daytime', overlays: 'N/A', dynamics: 'pedestrians far in background' },
  spatialFraming: { shotSize: 'full body', subjectPosition: 'center', depth: 'subject foreground, street midground' },
  camera: { movement: 'slow backward dolly', angle: 'eye level', steadiness: 'gimbal-smooth', speed: 'real-time' },
  lighting: { direction: 'overcast sky, soft top light', quality: 'soft diffused' },
  colorGrade: 'cool, slightly desaturated',
  skinTexture: 'natural pores, minimal retouch',
  pacing: 'steady single take, medium energy',
  whatMakesItWork: ['clean full-body product view', 'natural walking motion', 'simple color contrast'],
  differentiationSeeds: ['move to a plain studio backdrop', 'golden-hour park path instead of street', 'add a turn-and-pose beat at the end'],
};

const VALID = JSON.stringify({
  summary: 'A woman applies lipstick to camera.',
  subject: { description: 'woman, 20s', outfitStyle: 'casual' },
  beats: [{ t: '0s', action: 'uncaps lipstick' }, { t: '2s', action: 'applies to lips' }],
  scene: { setting: 'bathroom', timeOfDay: 'day', overlays: 'N/A', dynamics: 'static' },
  spatialFraming: { shotSize: 'close-up', subjectPosition: 'centered', depth: 'shallow' },
  camera: { movement: 'static', angle: 'eye-level', steadiness: 'handheld', speed: 'slow' },
  lighting: { direction: 'front-left key', quality: 'soft diffused' },
  colorGrade: 'warm, lifted blacks',
  skinTexture: 'natural pores, minimal retouch',
  pacing: 'calm',
  whatMakesItWork: ['relatable', 'clear product', 'clean light'],
  differentiationSeeds: ['plain studio backdrop', 'add a smile beat', 'morning light'],
});

function fakeClient(reply: string | Error) {
  return {
    messages: {
      create: async () => {
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  } as unknown as Anthropic;
}

describe('describeReferenceVideo', () => {
  it('extracts frames and returns the parsed 5-aspect brief', async () => {
    const extracted: string[] = [];
    const brief = await describeReferenceVideo('media/jobs/9/source.mp4', {
      extract: async (v, n) => { extracted.push(`${v}:${n}`); return ['a.jpg', 'b.jpg']; },
      client: fakeClient(JSON.stringify(validBrief)),
      readImage: () => 'ZmFrZQ==',
    });
    expect(extracted[0]).toContain('source.mp4');
    expect(brief.subject.outfitStyle).toContain('leather jacket');
    expect(brief.differentiationSeeds.length).toBeGreaterThan(0);
  });

  it('throws when the reply is unparseable — a bad brief must fail loudly, not silently produce a bad video', async () => {
    await expect(
      describeReferenceVideo('x.mp4', {
        extract: async () => ['a.jpg'],
        client: fakeClient('sorry, no JSON here'),
        readImage: () => 'ZmFrZQ==',
      })
    ).rejects.toThrow(/brief/i);
  });

  it('throws when required aspects are missing from the reply', async () => {
    const incomplete = { summary: 'a video' };
    await expect(
      describeReferenceVideo('x.mp4', {
        extract: async () => ['a.jpg'],
        client: fakeClient(JSON.stringify(incomplete)),
        readImage: () => 'ZmFrZQ==',
      })
    ).rejects.toThrow(/brief/i);
  });

  it('samples 14 frames for finer temporal resolution', async () => {
    let requestedCount = 0;
    await describeReferenceVideo('x.mp4', {
      extract: async (_v, n) => { requestedCount = n; return ['a.jpg']; },
      client: fakeClient(VALID),
      readImage: () => 'A',
    });
    expect(requestedCount).toBe(14);
  });

  it('parses the enriched brief including lighting, colorGrade, skinTexture, beats', async () => {
    const brief = await describeReferenceVideo('/tmp/x.mp4', {
      extract: async () => ['/tmp/f1.jpg'],
      client: fakeClient(VALID),
      readImage: () => 'AAAA',
    });
    expect(brief.lighting.direction).toContain('front-left');
    expect(brief.colorGrade).toBe('warm, lifted blacks');
    expect(brief.skinTexture).toContain('pores');
    expect(brief.beats.map((b) => b.action)).toContain('applies to lips');
  });

  it('throws when a new required field is missing', async () => {
    const bad = JSON.parse(VALID);
    delete bad.lighting;
    await expect(
      describeReferenceVideo('/tmp/x.mp4', {
        extract: async () => ['/tmp/f1.jpg'],
        client: fakeClient(JSON.stringify(bad)),
        readImage: () => 'A',
      })
    ).rejects.toThrow(/missing/);
  });
});

describe('buildGenerationPrompt', () => {
  it('composes an i2v prompt from the brief, keeping the avatar/product identity anchored to the reference image', () => {
    const prompt = buildGenerationPrompt(validBrief as VideoBrief);
    // The person and outfit come from the dressed-avatar image, not the reference clip's subject.
    expect(prompt).toMatch(/person in the (reference|input) image/i);
    expect(prompt).not.toContain(validBrief.subject.description);
    // Motion, framing and camera survive from the analysis.
    expect(prompt).toContain('walks slowly toward camera');
    expect(prompt).toContain('full body');
    expect(prompt).toContain('slow backward dolly');
    // A differentiation seed replaces the original setting.
    expect(prompt).toContain(validBrief.differentiationSeeds[0]);
    expect(prompt).not.toContain('downtown sidewalk beside glass storefronts');
  });

  it('includes beats, lighting and a realism cue', () => {
    const brief = JSON.parse(VALID) as VideoBrief;
    const p = buildGenerationPrompt(brief);
    expect(p).toContain('applies to lips');
    expect(p).toContain('soft diffused');
    expect(p.toLowerCase()).toMatch(/film grain|pores|natural skin/);
  });

  it('caps beats to the first 5 so a long brief does not make the model rush and morph props', () => {
    const brief = {
      ...validBrief,
      beats: Array.from({ length: 11 }, (_, i) => ({ t: `${i * 2}s`, action: `beat-action-${i}` })),
    } as VideoBrief;
    const p = buildGenerationPrompt(brief);
    expect(p).toContain('beat-action-4'); // 5th beat kept
    expect(p).not.toContain('beat-action-5'); // 6th beat dropped
    expect(p).not.toContain('beat-action-10');
  });

  it('includes a product-consistency clause to stop held objects morphing', () => {
    const p = buildGenerationPrompt(validBrief as VideoBrief);
    expect(p.toLowerCase()).toMatch(/consistent shape.*color|no new objects appear/);
  });
});

const VALID_PHOTO = JSON.stringify({
  summary: 'A woman holds a lipstick beside her face.',
  subject: { description: 'woman, 20s', outfitStyle: 'casual' },
  scene: { setting: 'bedroom', timeOfDay: 'day', overlays: 'N/A' },
  spatialFraming: { shotSize: 'medium close-up', subjectPosition: 'centered', depth: 'shallow' },
  lighting: { direction: 'window left', quality: 'soft' },
  colorGrade: 'warm pastel',
  skinTexture: 'natural, light freckles',
  whatMakesItWork: ['clean', 'product visible', 'flattering light'],
  differentiationSeeds: ['plain studio backdrop', 'brighter key', 'add a smile'],
});

it('describeReferencePhoto parses a single-frame brief', async () => {
  const brief = await describeReferencePhoto('/tmp/p.jpg', { client: fakeClient(VALID_PHOTO), readImage: () => 'A' });
  expect(brief.lighting.quality).toBe('soft');
  expect(brief.colorGrade).toBe('warm pastel');
});

it('describeReferencePhoto throws on missing field', async () => {
  const bad = JSON.parse(VALID_PHOTO); delete bad.colorGrade;
  await expect(describeReferencePhoto('/tmp/p.jpg', { client: fakeClient(JSON.stringify(bad)), readImage: () => 'A' }))
    .rejects.toThrow(/missing/);
});

it('buildPhotoPrompt includes setting, lighting and realism cue', () => {
  const p = buildPhotoPrompt(JSON.parse(VALID_PHOTO) as PhotoBrief);
  expect(p).toContain('plain studio backdrop');
  expect(p).toContain('soft');
  expect(p.toLowerCase()).toMatch(/film grain|pores|natural skin/);
});
