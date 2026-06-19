import { getDb } from '@/lib/db';

export default function ReadyPage() {
  const db = getDb();
  const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'ready' ORDER BY updated_at DESC").all() as any[];
  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Ready to Post</h1>
      <a href="/" style={{ display: 'inline-block', marginBottom: '1.5rem', color: '#0070f3' }}>&larr; Back to Dashboard</a>
      {jobs.length === 0 && <p style={{ color: '#888' }}>No finished videos yet.</p>}
      {jobs.map((j) => (
        <article key={j.id} style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Job #{j.id}</p>
          {j.output_path && (
            <>
              <video src={'/' + j.output_path} controls width={320} style={{ display: 'block', marginBottom: '0.5rem' }} />
              <a href={'/' + j.output_path} download style={{ color: '#0070f3' }}>Download</a>
            </>
          )}
        </article>
      ))}
    </main>
  );
}
