import { describe, it, expect } from 'vitest';
import { buildFilter, distinctify } from './postprocess';

describe('buildFilter', () => {
  it('includes hue, crop and setpts for default light touch', () => {
    const f = buildFilter();
    expect(f).toContain('hue=');
    expect(f).toContain('crop=');
    expect(f).toContain('setpts=');
  });
});

describe('distinctify', () => {
  it('invokes ffmpeg runner with built filter and returns output path', async () => {
    let seen = '';
    const runFfmpeg = async (_i: string, _o: string, filter: string) => { seen = filter; };
    const out = await distinctify('in.mp4', 'out.mp4', { runFfmpeg });
    expect(out).toBe('out.mp4');
    expect(seen).toContain('crop=');
  });
});
