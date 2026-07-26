import { describe, it, expect } from 'vitest';
import type { PathLike } from 'node:fs';
import { getDb } from './db';
import { getSavedAvatarPath, saveAvatarChoice, clearSavedAvatar } from './avatar';

describe('avatar', () => {
  it('returns null when no avatar has been saved', () => {
    const db = getDb(':memory:');
    expect(getSavedAvatarPath(db)).toBeNull();
  });

  it('saves a chosen avatar into the library and records it as the default', () => {
    const db = getDb(':memory:');
    const copied: Array<[string, string]> = [];
    const copyFile = (src: PathLike, dest: PathLike) => { copied.push([String(src), String(dest)]); };
    const mkdir = (() => undefined) as typeof import('node:fs').mkdirSync;
    const result = saveAvatarChoice(db, 'media/avatar-options/option-1.jpg', { copyFile, mkdir });
    expect(result).toMatch(/^media\/avatars\/avatar-\d+\.jpg$/);
    expect(copied).toEqual([['media/avatar-options/option-1.jpg', result]]);
    expect(getSavedAvatarPath(db)).toBe(result);
  });

  it('keeps a single default row across repeated saves, pointing at the newest', () => {
    const db = getDb(':memory:');
    const copyFile = () => {};
    const mkdir = (() => undefined) as typeof import('node:fs').mkdirSync;
    saveAvatarChoice(db, 'media/avatar-options/option-0.jpg', { copyFile, mkdir });
    const second = saveAvatarChoice(db, 'media/avatar-options/option-2.jpg', { copyFile, mkdir });
    expect(getSavedAvatarPath(db)).toBe(second);
    const count = db.prepare('SELECT COUNT(*) as c FROM avatar').get() as any;
    expect(count.c).toBe(1);
  });

  it('clears the saved avatar', () => {
    const db = getDb(':memory:');
    const copyFile = () => {};
    saveAvatarChoice(db, 'media/avatar-options/option-0.jpg', { copyFile });
    const rm = () => {};
    clearSavedAvatar(db, { rm });
    expect(getSavedAvatarPath(db)).toBeNull();
  });
});
