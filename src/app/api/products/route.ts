import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { classifyProduct } from '@/lib/classifier';
import { getMemory } from '@/lib/memory';

export async function POST(req: Request) {
  const { clientName, imageBase64 } = (await req.json()) as { clientName: string; imageBase64: string };
  const db = getDb();
  const classification = await classifyProduct(imageBase64);
  const remembered = getMemory(db, classification.type);
  const client = db.prepare('INSERT INTO clients (name) VALUES (?)').run(clientName ?? 'Client');
  const product = db
    .prepare('INSERT INTO products (client_id, type, industry, keywords_json) VALUES (?, ?, ?, ?)')
    .run(client.lastInsertRowid, classification.type, classification.industry, JSON.stringify(classification.keywords));
  return NextResponse.json({ productId: Number(product.lastInsertRowid), classification, remembered });
}
