'use client';
import { useState, useEffect, useCallback } from 'react';

type Job = {
  id: number;
  status: string;
  product_id: number;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#888',
  classifying: '#2196F3',
  scripting: '#9C27B0',
  rendering: '#FF9800',
  postprocessing: '#00BCD4',
  ready: '#4CAF50',
  failed: '#F44336',
};

export function JobQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [advancing, setAdvancing] = useState<number | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      // silently ignore polling errors
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 4000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  async function advanceJob(id: number) {
    setAdvancing(id);
    try {
      await fetch(`/api/jobs/${id}/advance`, { method: 'POST' });
      await fetchJobs();
    } finally {
      setAdvancing(null);
    }
  }

  return (
    <section style={{ padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h2 style={{ marginTop: 0 }}>Job Queue</h2>
      {jobs.length === 0 && <p style={{ color: '#888' }}>No jobs yet. Upload a product to create one.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {jobs.map((job) => (
          <li key={job.id} style={{ padding: '0.75rem', marginBottom: '0.5rem', background: '#fafafa', borderRadius: '6px', border: '1px solid #eee' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Job #{job.id}</span>
              <span style={{
                padding: '2px 8px',
                borderRadius: '4px',
                background: STATUS_COLORS[job.status] ?? '#888',
                color: '#fff',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}>
                {job.status}
              </span>
              {job.status !== 'ready' && (
                <button
                  onClick={() => advanceJob(job.id)}
                  disabled={advancing === job.id}
                  style={{ padding: '4px 12px', cursor: advancing === job.id ? 'not-allowed' : 'pointer' }}
                >
                  {job.status === 'failed' ? 'Retry' : 'Advance'}
                </button>
              )}
            </div>
            {job.error && (
              <p style={{ color: 'red', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                Error: {job.error}
              </p>
            )}
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#aaa' }}>
              Updated: {new Date(job.updated_at).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
