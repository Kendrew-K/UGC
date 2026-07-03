import fs from 'node:fs';
import type Database from 'better-sqlite3';

const AVATAR_PATH = 'media/avatar.jpg';

/** Returns the currently saved avatar's path, or null if none has been chosen yet. */
export function getSavedAvatarPath(db: Database.Database): string | null {
  const row = db.prepare('SELECT image_path FROM avatar WHERE id = 1').get() as
    | { image_path: string }
    | undefined;
  return row?.image_path ?? null;
}

/** Copies the chosen avatar option to the fixed saved-avatar path and records it, replacing any prior choice. */
export function saveAvatarChoice(
  db: Database.Database,
  chosenPath: string,
  deps: { copyFile?: typeof fs.copyFileSync } = {}
): string {
  const copyFile = deps.copyFile ?? fs.copyFileSync;
  copyFile(chosenPath, AVATAR_PATH);
  db.prepare(
    "INSERT INTO avatar (id, image_path, updated_at) VALUES (1, ?, datetime('now')) " +
      "ON CONFLICT(id) DO UPDATE SET image_path = excluded.image_path, updated_at = excluded.updated_at"
  ).run(AVATAR_PATH);
  return AVATAR_PATH;
}

/** Removes the saved avatar so the picker flow can run again. Best-effort: a missing file never throws. */
export function clearSavedAvatar(db: Database.Database, deps: { rm?: typeof fs.rmSync } = {}): void {
  const rm = deps.rm ?? fs.rmSync;
  db.prepare('DELETE FROM avatar WHERE id = 1').run();
  try {
    rm(AVATAR_PATH, { force: true });
  } catch {
    // ignore — cleanup must never fail the clear operation
  }
}
