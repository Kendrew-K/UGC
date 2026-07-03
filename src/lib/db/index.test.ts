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

describe('avatar + job name migrations', () => {
  it('creates the avatar table', () => {
    const db = getDb(':memory:');
    db.prepare("INSERT INTO avatar (id, image_path) VALUES (1, 'media/avatar.jpg')").run();
    const row = db.prepare('SELECT image_path FROM avatar WHERE id = 1').get() as any;
    expect(row.image_path).toBe('media/avatar.jpg');
  });

  it('adds a name column to jobs', () => {
    const db = getDb(':memory:');
    const cl = db.prepare('INSERT INTO clients (name) VALUES (?)').run('Test');
    const pr = db.prepare('INSERT INTO products (client_id, type) VALUES (?, ?)').run(cl.lastInsertRowid, 'skincare');
    const job = db.prepare('INSERT INTO jobs (product_id, name) VALUES (?, ?)').run(pr.lastInsertRowid, 'My Job');
    const row = db.prepare('SELECT name FROM jobs WHERE id = ?').get(job.lastInsertRowid) as any;
    expect(row.name).toBe('My Job');
  });
});
