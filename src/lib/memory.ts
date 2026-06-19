import type Database from 'better-sqlite3';

export function saveMemory(db: Database.Database, productType: string, answers: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO product_memory (product_type, answers_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(product_type) DO UPDATE SET answers_json = excluded.answers_json, updated_at = datetime('now')`
  ).run(productType, JSON.stringify(answers));
}

export function getMemory(db: Database.Database, productType: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT answers_json FROM product_memory WHERE product_type = ?').get(productType) as
    | { answers_json: string }
    | undefined;
  return row ? JSON.parse(row.answers_json) : null;
}
