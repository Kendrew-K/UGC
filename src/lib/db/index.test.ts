import { describe, it, expect } from 'vitest';
import { getDb } from './index';

describe('getDb', () => {
  it('creates schema and round-trips a client', () => {
    const db = getDb(':memory:');
    const info = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Acme');
    const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
    expect(row).toMatchObject({ name: 'Acme' });
  });

  it('has a product_memory table keyed by product_type', () => {
    const db = getDb(':memory:');
    db.prepare("INSERT INTO product_memory (product_type, answers_json) VALUES ('makeup', '{}')").run();
    const row = db.prepare("SELECT * FROM product_memory WHERE product_type = 'makeup'").get();
    expect(row).toBeTruthy();
  });
});
