import { NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { classifyProduct } from '@/lib/classifier';
import { getMemory } from '@/lib/memory';

export async function POST(req: Request) {
  try {
    const { clientName, imageBase64 } = (await req.json()) as { clientName: string; imageBase64: string };
    if (!imageBase64) return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    const db = getDb();
    const classification = await classifyProduct(imageBase64);
    const remembered = getMemory(db, classification.type);
    const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run(clientName ?? 'Client');
    const product = db
      .prepare(
        'INSERT INTO products (client_id, type, industry, gender, keywords_json, search_queries_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        client.lastInsertRowid,
        classification.type,
        classification.industry,
        classification.gender,
        JSON.stringify(classification.keywords),
        JSON.stringify(classification.searchQueries)
      );
    const productId = Number(product.lastInsertRowid);
    // Persist the photo — the pipeline dresses the avatar in this product
    // before the swap, so it must survive past classification.
    const photoPath = `media/products/${productId}.jpg`;
    fs.mkdirSync('media/products', { recursive: true });
    fs.writeFileSync(photoPath, Buffer.from(imageBase64, 'base64'));
    db.prepare('UPDATE products SET photo_path = ? WHERE id = ?').run(photoPath, productId);
    return NextResponse.json({ productId, classification, remembered });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/products] classification failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
