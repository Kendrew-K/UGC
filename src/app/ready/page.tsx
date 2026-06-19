import { getDb } from '@/lib/db';

function safeMediaPath(p: string | null): string | null {
  if (!p) return null;
  // Must be a relative path under media/ with no traversal or null bytes
  if (!/^media\//.test(p) || p.includes('..') || p.includes('\0')) return null;
  return p;
}

export default function ReadyPage() {
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'ready' ORDER BY updated_at DESC").all() as any[];
  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Ready to Post</h1>
      <a href="/" style={{ display: 'inline-block', marginBottom: '1.5rem', color: '#0070f3' }}>&larr; Back to Dashboard</a>
      {jobs.length === 0 && <p style={{ color: '#888' }}>No finished videos yet.</p>}
      {jobs.map((j) => {
        const safePath = safeMediaPath(j.output_path);
        if (!safePath) return null;
        return (
          <article key={j.id} style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
            <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Job #{j.id}</p>
            <video src={'/' + safePath} controls width={320} style={{ display: 'block', marginBottom: '0.5rem' }} />
            <a href={'/' + safePath} download style={{ color: '#0070f3' }}>Download</a>
          </article>
        );
      })}
    </main>
  );
}
