import { describe, it, expect } from 'vitest';
import { getDb } from './db';
import { saveMemory, getMemory } from './memory';

describe('product memory', () => {
  it('returns null when no memory saved', () => {
    const db = getDb(':memory:');
    expect(getMemory(db, 'makeup')).toBeNull();
  });

  it('saves and retrieves answers by product type', () => {
    const db = getDb(':memory:');
    saveMemory(db, 'makeup', { vibe: 'GRWM', faceSource: 'upload' });
    expect(getMemory(db, 'makeup')).toEqual({ vibe: 'GRWM', faceSource: 'upload' });
  });

  it('overwrites on repeat save', () => {
    const db = getDb(':memory:');
    saveMemory(db, 'makeup', { vibe: 'GRWM' });
    saveMemory(db, 'makeup', { vibe: 'unboxing' });
    expect(getMemory(db, 'makeup')).toEqual({ vibe: 'unboxing' });
  });
});
