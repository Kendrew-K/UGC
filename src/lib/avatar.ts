import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const AVATARS_DIR = 'media/avatars';
const LEGACY_AVATAR_PATH = 'media/avatar.jpg';

/** Returns the default (most recently chosen) avatar's path, or null if none exists. */
export function getSavedAvatarPath(db: Database.Database): string | null {
  const row = db.prepare('SELECT image_path FROM avatar WHERE id = 1').get() as
    | { image_path: string }
    | undefined;
  return row?.image_path ?? null;
}

/** All saved avatars the client can pick from, newest first. Includes the
 * pre-library single avatar (media/avatar.jpg) if it exists. */
export function listAvatars(db: Database.Database, deps: { fsMod?: typeof fs } = {}): string[] {
  const f = deps.fsMod ?? fs;
  const found: string[] = [];
  if (f.existsSync(AVATARS_DIR)) {
    const files = f
      .readdirSync(AVATARS_DIR)
      .filter((n) => /\.(jpe?g|png)$/i.test(n))
      .sort()
      .reverse();
    found.push(...files.map((n) => path.posix.join(AVATARS_DIR, n)));
  }
  if (f.existsSync(LEGACY_AVATAR_PATH)) found.push(LEGACY_AVATAR_PATH);
  // The db's current choice should always be offered even if it lives elsewhere.
  const current = getSavedAvatarPath(db);
  if (current && !found.includes(current) && f.existsSync(current)) found.unshift(current);
  return found;
}

/** Adds the chosen avatar option to the library and records it as the default choice. */
export function saveAvatarChoice(
  db: Database.Database,
  chosenPath: string,
  deps: { copyFile?: typeof fs.copyFileSync; mkdir?: typeof fs.mkdirSync } = {}
): string {
  const copyFile = deps.copyFile ?? fs.copyFileSync;
  const mkdir = deps.mkdir ?? fs.mkdirSync;
  mkdir(AVATARS_DIR, { recursive: true });
  const dest = path.posix.join(AVATARS_DIR, `avatar-${Date.now()}.jpg`);
  copyFile(chosenPath, dest);
  db.prepare(
    "INSERT INTO avatar (id, image_path, updated_at) VALUES (1, ?, datetime('now')) " +
      "ON CONFLICT(id) DO UPDATE SET image_path = excluded.image_path, updated_at = excluded.updated_at"
  ).run(dest);
  return dest;
}

/** Removes one avatar from the library; if it was the default, promotes the next one. */
export function deleteAvatar(db: Database.Database, avatarPath: string, deps: { rm?: typeof fs.rmSync } = {}): void {
  const rm = deps.rm ?? fs.rmSync;
  try {
    rm(avatarPath, { force: true });
  } catch {
    // ignore — a missing file must not block removal from the library
  }
  if (getSavedAvatarPath(db) === avatarPath) {
    const next = listAvatars(db)[0] ?? null;
    if (next) {
      db.prepare("UPDATE avatar SET image_path = ?, updated_at = datetime('now') WHERE id = 1").run(next);
    } else {
      db.prepare('DELETE FROM avatar WHERE id = 1').run();
    }
  }
}

/** Removes the saved avatar record and legacy file so the picker flow can run again. */
export function clearSavedAvatar(db: Database.Database, deps: { rm?: typeof fs.rmSync } = {}): void {
  const rm = deps.rm ?? fs.rmSync;
  db.prepare('DELETE FROM avatar WHERE id = 1').run();
  try {
    rm(LEGACY_AVATAR_PATH, { force: true });
  } catch {
    // ignore — cleanup must never fail the clear operation
  }
}
