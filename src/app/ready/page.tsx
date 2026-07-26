import { getDb } from '@/lib/db';
import { JOB_LABEL } from '@/lib/config';

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
    <main className="page">
      <div className="page-header">
        <h1>Ready to Post</h1>
        <a href="/" className="nav-link">&larr; Back to Dashboard</a>
      </div>
      {jobs.length === 0 && <p className="muted">No finished videos yet. They&rsquo;ll show up here once a job completes.</p>}
      {jobs.map((j) => {
        const safePath = safeMediaPath(j.output_path);
        if (!safePath) return null;
        const isImage = /\.(jpe?g|png|webp)$/i.test(safePath);
        return (
          <article key={j.id} className="card">
            <p style={{ fontWeight: 650, marginBottom: '0.75rem' }}>{j.name ?? `${JOB_LABEL} #${j.id}`}</p>
            {isImage ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={'/' + safePath} alt="Finished picture" width={320} style={{ display: 'block', marginBottom: '0.75rem', borderRadius: 10 }} />
            ) : (
              <video src={'/' + safePath} controls width={320} style={{ display: 'block', marginBottom: '0.75rem', borderRadius: 10 }} />
            )}
            <a href={'/' + safePath} download className="btn btn-primary btn-sm">{isImage ? 'Download picture' : 'Download video'}</a>
          </article>
        );
      })}
    </main>
  );
}
