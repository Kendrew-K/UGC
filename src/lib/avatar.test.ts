import { describe, it, expect } from 'vitest';
import type { PathLike } from 'node:fs';
import { getDb } from './db';
import { getSavedAvatarPath, saveAvatarChoice, clearSavedAvatar } from './avatar';

describe('avatar', () => {
  it('returns null when no avatar has been saved', () => {
    const db = getDb(':memory:');
    expect(getSavedAvatarPath(db)).toBeNull();
  });

  it('saves a chosen avatar, copying it to media/avatar.jpg and recording it', () => {
    const db = getDb(':memory:');
    const copied: Array<[string, string]> = [];
    const copyFile = (src: PathLike, dest: PathLike) => { copied.push([String(src), String(dest)]); };
    const result = saveAvatarChoice(db, 'media/avatar-options/option-1.jpg', { copyFile });
    expect(result).toBe('media/avatar.jpg');
    expect(copied).toEqual([['media/avatar-options/option-1.jpg', 'media/avatar.jpg']]);
    expect(getSavedAvatarPath(db)).toBe('media/avatar.jpg');
  });

  it('replaces a previously saved avatar rather than erroring on a second save', () => {
    const db = getDb(':memory:');
    const copyFile = () => {};
    saveAvatarChoice(db, 'media/avatar-options/option-0.jpg', { copyFile });
    saveAvatarChoice(db, 'media/avatar-options/option-2.jpg', { copyFile });
    expect(getSavedAvatarPath(db)).toBe('media/avatar.jpg');
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
