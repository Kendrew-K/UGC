'use client';
import { useState } from 'react';

export function ProductUpload() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const b64 = btoa(binary);
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName: 'Me', imageBase64: b64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed');
      setResult(data);
    } catch (err: any) {
      setError(err.message ?? 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h2 style={{ marginTop: 0 }}>Upload product photo</h2>
      <input type="file" accept="image/*" onChange={onFile} disabled={loading} />
      {loading && <p style={{ color: '#888' }}>Classifying…</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
      {result && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#f5f5f5', borderRadius: '6px' }}>
          <p><strong>Type:</strong> {result.classification?.type}</p>
          <p><strong>Industry:</strong> {result.classification?.industry}</p>
          <p><strong>Keywords:</strong> {result.classification?.keywords?.join(', ')}</p>
          {result.remembered
            ? <p style={{ color: 'green' }}>We remember this product — using saved answers</p>
            : <p>New product — answer the questions below.</p>
          }
        </div>
      )}
    </section>
  );
}
