import { describe, it, expect } from 'vitest';
import { getSwapProvider } from './index';

describe('getSwapProvider', () => {
  it('returns a fal provider by name', () => {
    const p = getSwapProvider('fal');
    expect(typeof p.swap).toBe('function');
  });

  it('returns a replicate provider by name', () => {
    const p = getSwapProvider('replicate');
    expect(typeof p.swap).toBe('function');
  });

  it('returns a kie provider by name', () => {
    const p = getSwapProvider('kie');
    expect(typeof p.swap).toBe('function');
  });

  it('throws on unknown provider', () => {
    expect(() => getSwapProvider('bogus')).toThrow();
  });
});
