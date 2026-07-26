import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { judgeFrames, checkVideoQuality, checkImageQuality, checkAvatarIdentity } from './qc';

/** Fake Anthropic client returning a canned text reply (or throwing). */
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

const readImage = () => 'ZmFrZQ=='; // fake base64 so tests need no real files

describe('judgeFrames', () => {
  it('fails when Claude reports generation artifacts', async () => {
    const client = fakeClient('{"pass":false,"reason":"person has three legs in frame 2"}');
    const res = await judgeFrames(['f1.jpg', 'f2.jpg'], 'test prompt', { client, readImage });
    expect(res.pass).toBe(false);
    expect(res.reason).toContain('three legs');
  });

  it('passes when Claude approves the frames', async () => {
    const client = fakeClient('{"pass":true,"reason":"clean"}');
    const res = await judgeFrames(['f1.jpg'], 'test prompt', { client, readImage });
    expect(res.pass).toBe(true);
  });

  it('fails OPEN when the API call errors - never discard a paid swap over a QC blip', async () => {
    const client = fakeClient(new Error('api down'));
    const res = await judgeFrames(['f1.jpg'], 'test prompt', { client, readImage });
    expect(res.pass).toBe(true);
    expect(res.reason).toContain('skipped');
  });

  it('fails OPEN when the reply is unparseable', async () => {
    const client = fakeClient('sorry, I cannot do that');
    const res = await judgeFrames(['f1.jpg'], 'test prompt', { client, readImage });
    expect(res.pass).toBe(true);
    expect(res.reason).toContain('skipped');
  });
});

describe('checkVideoQuality', () => {
  it('extracts frames from the video and judges them', async () => {
    const judged: string[][] = [];
    const res = await checkVideoQuality('media/jobs/9/swapped.mp4', {
      extract: async () => ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      judge: async (paths) => { judged.push(paths); return { pass: false, reason: 'ghosting' }; },
    });
    expect(judged[0]).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    expect(res).toEqual({ pass: false, reason: 'ghosting' });
  });

  it('fails OPEN when frame extraction errors', async () => {
    const res = await checkVideoQuality('x.mp4', {
      extract: async () => { throw new Error('no ffmpeg'); },
      judge: async () => ({ pass: false, reason: 'should not be reached' }),
    });
    expect(res.pass).toBe(true);
    expect(res.reason).toContain('skipped');
  });
});

describe('checkImageQuality', () => {
  it('judges the single image', async () => {
    const judged: string[][] = [];
    const res = await checkImageQuality('media/jobs/9/swapped.jpg', {
      judge: async (paths) => { judged.push(paths); return { pass: false, reason: 'extra limb' }; },
    });
    expect(judged[0]).toEqual(['media/jobs/9/swapped.jpg']);
    expect(res.pass).toBe(false);
  });
});

describe('checkAvatarIdentity', () => {
  it('compares face photo against dressed avatar, face first', async () => {
    const judged: { paths: string[]; prompt: string } = { paths: [], prompt: '' };
    const res = await checkAvatarIdentity('media/face.jpg', 'media/jobs/9/dressed.jpg', {
      judge: async (paths, prompt) => { judged.paths = paths; judged.prompt = prompt; return { pass: false, reason: 'different person' }; },
    });
    expect(judged.paths).toEqual(['media/face.jpg', 'media/jobs/9/dressed.jpg']);
    expect(judged.prompt).toMatch(/same person/i);
    expect(res).toEqual({ pass: false, reason: 'different person' });
  });

  it('passes when the dressed avatar is the same person', async () => {
    const res = await checkAvatarIdentity('media/face.jpg', 'media/jobs/9/dressed.jpg', {
      judge: async () => ({ pass: true, reason: 'same person' }),
    });
    expect(res.pass).toBe(true);
  });
});
