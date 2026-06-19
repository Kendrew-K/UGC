import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

export function getDb(dbPath = process.env.UGC_DB_PATH ?? 'media/app.sqlite'): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
