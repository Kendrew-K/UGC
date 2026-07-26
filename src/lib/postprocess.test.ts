import { describe, it, expect } from 'vitest';
import {
  buildFilter, buildAudioFilter, buildImageFilter, distinctify, distinctifyImage,
  VIDEO_ENCODE_OPTIONS, IMAGE_ENCODE_OPTIONS,
} from './postprocess';

describe('encode options', () => {
  it('re-encodes video near-losslessly — the swap output is fragile, defaults shave more quality off it', () => {
    expect(VIDEO_ENCODE_OPTIONS).toContain('-crf 18');
    expect(VIDEO_ENCODE_OPTIONS).toContain('-preset slow');
  });

  it('writes images at high jpeg quality', () => {
    expect(IMAGE_ENCODE_OPTIONS).toContain('-q:v 2');
  });
});

describe('buildFilter', () => {
  it('includes hue, crop and setpts for default light touch', () => {
    const f = buildFilter();
    expect(f).toContain('hue=');
    expect(f).toContain('crop=');
    expect(f).toContain('setpts=');
  });

  it('rounds the scaled output to even dimensions (libx264 rejects odd)', () => {
    expect(buildFilter()).toContain('/2)*2');
  });
});

describe('buildAudioFilter', () => {
  it('matches the video speed change so audio stays in sync', () => {
    expect(buildAudioFilter({ speed: 1.03 })).toBe('atempo=1.03');
  });
});

describe('buildImageFilter', () => {
  it('keeps hue + crop but has no speed change (photos have no timeline)', () => {
    const f = buildImageFilter();
    expect(f).toContain('hue=');
    expect(f).toContain('crop=');
    expect(f).not.toContain('setpts=');
  });
});

describe('distinctifyImage', () => {
  it('invokes the runner with the image filter and returns the output path', async () => {
    let seen = '';
    const runFfmpeg = async (_i: string, _o: string, filter: string) => { seen = filter; };
    const out = await distinctifyImage('in.jpg', 'out.jpg', { runFfmpeg });
    expect(out).toBe('out.jpg');
    expect(seen).toContain('crop=');
  });
});

describe('distinctify', () => {
  it('invokes ffmpeg runner with video and audio filters, returns output path', async () => {
    let seenVideo = '';
    let seenAudio = '';
    const runFfmpeg = async (_i: string, _o: string, filter: string, audioFilter: string) => {
      seenVideo = filter;
      seenAudio = audioFilter;
    };
    const out = await distinctify('in.mp4', 'out.mp4', { runFfmpeg });
    expect(out).toBe('out.mp4');
    expect(seenVideo).toContain('crop=');
    expect(seenAudio).toContain('atempo=');
  });
});
