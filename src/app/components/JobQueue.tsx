'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { JOB_LABEL } from '@/lib/config';

type Candidate = {
  url: string;
  views: number;
  downloadUrl: string;
  hasVoice: boolean;
  platform: string;
  title?: string;
  hashtags?: string[];
  relevanceScore?: number;
  reason?: string;
};

type Job = {
  id: number;
  status: string;
  product_id: number;
  error?: string | null;
  name?: string | null;
  candidates_json?: string | null;
  output_path?: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_META: Record<string, { color: string; label: string }> = {
  generating_face: { color: '#FF9800', label: 'Generating avatar…' },
  queued: { color: '#888', label: 'Queued' },
  awaiting_approval: { color: '#2196F3', label: 'Pick a clip ↓' },
  downloading: { color: '#FF9800', label: 'Downloading clip' },
  swapping: { color: '#9C27B0', label: 'Face-swapping video' },
  processing: { color: '#00BCD4', label: 'Finishing up' },
  ready: { color: '#4CAF50', label: 'Ready to post 🎉' },
  failed: { color: '#F44336', label: 'Failed' },
};

const AUTO_STATUSES = new Set(['generating_face', 'queued', 'downloading', 'swapping', 'processing']);

export function JobQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const advancing = useRef<Set<number>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

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
    const interval = setInterval(fetchJobs, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  // Auto-advance any job that doesn't need human input.
  useEffect(() => {
    for (const job of jobs) {
      if (!AUTO_STATUSES.has(job.status)) continue;
      if (advancing.current.has(job.id)) continue;
      advancing.current.add(job.id);
      (async () => {
        try {
          await fetch(`/api/jobs/${job.id}/advance`, { method: 'POST' });
          await fetchJobs();
        } finally {
          advancing.current.delete(job.id);
        }
      })();
    }
  }, [jobs, fetchJobs]);

  /** Downloads the clip via our own scraper and opens the real video file,
   * since TikTok's own web player is unreliable for some scraped links. */
  async function preview(candidateUrl: string) {
    setPreviewing(candidateUrl);
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidateUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'preview failed');
      window.open(data.url, '_blank');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(null);
    }
  }

  async function approve(jobId: number, chosenIndex: number) {
    await fetch(`/api/jobs/${jobId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenIndex }),
    });
    await fetchJobs();
  }

  /** Persists a new display name for a job, then exits edit mode. */
  async function rename(jobId: number, name: string) {
    await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setEditingId(null);
    await fetchJobs();
  }

  /** Deletes a job outright (used for the trash button and for dismissing
   * a failed job before the 1-hour auto-sweep would otherwise remove it). */
  async function removeJob(jobId: number) {
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    await fetchJobs();
  }

  return (
    <section style={{ padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px', color: '#171717' }}>
      <h2 style={{ marginTop: 0 }}>{JOB_LABEL} Queue</h2>
      {jobs.length === 0 && <p style={{ color: '#888' }}>No {JOB_LABEL.toLowerCase()}s yet. Upload a product to create one.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {jobs.map((job) => {
          const candidates: Candidate[] = job.candidates_json ? JSON.parse(job.candidates_json) : [];
          return (
            <li key={job.id} style={{ padding: '0.75rem', marginBottom: '0.5rem', background: '#fafafa', borderRadius: '6px', border: '1px solid #eee' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                {editingId === job.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => rename(job.id, editingName.trim() || `${JOB_LABEL} #${job.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ fontWeight: 600, fontSize: '1rem', border: '1px solid #0070f3', borderRadius: 4, padding: '2px 6px' }}
                  />
                ) : (
                  <span
                    onClick={() => { setEditingId(job.id); setEditingName(job.name ?? `${JOB_LABEL} #${job.id}`); }}
                    style={{ fontWeight: 600, cursor: 'pointer' }}
                    title="Click to rename"
                  >
                    {job.name ?? `${JOB_LABEL} #${job.id}`}
                  </span>
                )}
                <span style={{
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: STATUS_META[job.status]?.color ?? '#888',
                  color: '#fff',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}>
                  {STATUS_META[job.status]?.label ?? job.status}
                </span>
                {AUTO_STATUSES.has(job.status) && <span style={{ fontSize: '0.8rem', color: '#888' }}>working…</span>}
                {job.status === 'ready' && job.output_path && (
                  <a href="/ready" style={{ color: '#0070f3', fontWeight: 600, fontSize: '0.85rem' }}>View →</a>
                )}
                <button
                  onClick={() => { if (confirm(`Delete ${job.name ?? `${JOB_LABEL} #${job.id}`}?`)) removeJob(job.id); }}
                  title="Delete this job"
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '1rem' }}
                >
                  🗑
                </button>
              </div>

              {job.status === 'awaiting_approval' && (
                <div style={{ marginTop: '0.75rem' }}>
                  <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>Choose a viral clip to base the video on:</p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {candidates.slice(0, 6).map((c, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => approve(job.id, i)}
                          style={{ padding: '4px 12px', cursor: 'pointer', background: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px' }}
                        >
                          Use this
                        </button>
                        {c.relevanceScore != null && (
                          <span title={c.reason} style={{
                            padding: '2px 7px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 700,
                            background: c.relevanceScore >= 7 ? '#4CAF50' : c.relevanceScore >= 5 ? '#FF9800' : '#F44336',
                            color: '#fff',
                          }}>
                            {c.relevanceScore}/10
                          </span>
                        )}
                        <span style={{ fontSize: '0.85rem' }}>
                          {c.views.toLocaleString()} views · {c.platform}
                          {c.title && <> · <em>{c.title.slice(0, 60)}</em></>}
                        </span>
                        <button
                          onClick={() => preview(c.url)}
                          disabled={previewing === c.url}
                          style={{ background: 'none', border: 'none', color: '#0070f3', fontSize: '0.8rem', cursor: 'pointer', padding: 0 }}
                        >
                          {previewing === c.url ? 'loading…' : 'preview'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {job.error && (
                <p style={{ color: 'red', margin: '0.5rem 0 0', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>Error: {job.error}</span>
                  {job.status === 'failed' && (
                    <button
                      onClick={() => removeJob(job.id)}
                      style={{ padding: '2px 8px', fontSize: '0.75rem', borderRadius: 4, border: '1px solid #F44336', background: '#fff', color: '#F44336', cursor: 'pointer' }}
                    >
                      Dismiss
                    </button>
                  )}
                </p>
              )}
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#aaa' }}>
                Updated: {new Date(job.updated_at).toLocaleString()}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
