import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/schema.sql'), 'utf8');

export function getDb(dbPath = process.env.UGC_DB_PATH ?? 'media/app.sqlite'): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Idempotent migrations for databases created before a column was added. */
function migrate(db: Database.Database) {
  const jobCols = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
  const hasJob = (name: string) => jobCols.some((c) => c.name === name);
  if (!hasJob('chosen_candidate_json')) db.exec('ALTER TABLE jobs ADD COLUMN chosen_candidate_json TEXT');
  if (!hasJob('face_prompt')) db.exec('ALTER TABLE jobs ADD COLUMN face_prompt TEXT');
  if (!hasJob('name')) db.exec('ALTER TABLE jobs ADD COLUMN name TEXT');
  if (!hasJob('media_type')) db.exec("ALTER TABLE jobs ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'");

  const prodCols = db.prepare('PRAGMA table_info(products)').all() as { name: string }[];
  const hasProd = (name: string) => prodCols.some((c) => c.name === name);
  if (!hasProd('gender')) db.exec('ALTER TABLE products ADD COLUMN gender TEXT');
  if (!hasProd('search_queries_json')) db.exec('ALTER TABLE products ADD COLUMN search_queries_json TEXT');
}
