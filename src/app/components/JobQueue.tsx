'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { JOB_LABEL } from '@/lib/config';

type Candidate = {
  url: string;
  views: number;
  durationS?: number;
  coverUrl?: string;
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
  media_type?: string | null;
  product_id: number;
  error?: string | null;
  name?: string | null;
  candidates_json?: string | null;
  output_path?: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS_META: Record<string, { pill: string; label: string }> = {
  generating_face: { pill: 'pill-amber', label: 'Generating avatar…' },
  queued: { pill: 'pill-gray', label: 'Queued' },
  awaiting_approval: { pill: 'pill-blue', label: 'Pick a clip ↓' },
  downloading: { pill: 'pill-amber', label: 'Downloading clip' },
  generating: { pill: 'pill-violet', label: 'Generating…' },
  processing: { pill: 'pill-violet', label: 'Finishing up' },
  ready: { pill: 'pill-green', label: 'Ready to post 🎉' },
  failed: { pill: 'pill-red', label: 'Failed' },
};

const AUTO_STATUSES = new Set(['generating_face', 'queued', 'downloading', 'generating', 'processing']);

/** TikTok blocks downloads for some clips (shop/restricted videos); the
 * scraper surfaces that as this error, and such a clip can't be used at all. */
function isUndownloadableError(message: string): boolean {
  return /no downloadable video url/i.test(message);
}

type Preview =
  | { candidateUrl: string; state: 'loading' }
  | { candidateUrl: string; state: 'ready'; videoUrl: string }
  | { candidateUrl: string; state: 'image'; imageUrl: string }
  | { candidateUrl: string; state: 'error'; message: string; blocked: boolean };

export function JobQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const advancing = useRef<Set<number>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
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

  /** Downloads the clip through the scraper's own browser session and plays
   * the local file in the modal. TikTok's embed player can't stream inside an
   * iframe (its CDN needs first-party cookies), so downloading is the only
   * reliable preview. First view of a clip takes ~30s; repeats are cached. */
  async function openPreview(candidate: Candidate, mediaType?: string | null) {
    // Photo posts need no downloader: the full-size image URL is directly viewable.
    if (mediaType === 'picture') {
      const imageUrl = candidate.downloadUrl || candidate.coverUrl;
      if (imageUrl) setPreview({ candidateUrl: candidate.url, state: 'image', imageUrl });
      return;
    }
    setPreview({ candidateUrl: candidate.url, state: 'loading' });
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidate.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Preview failed');
      setPreview((p) =>
        p?.candidateUrl === candidate.url ? { candidateUrl: candidate.url, state: 'ready', videoUrl: data.url } : p
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Preview failed';
      const blocked = isUndownloadableError(message);
      if (blocked) setUnavailable((prev) => new Set(prev).add(candidate.url));
      setPreview((p) =>
        p?.candidateUrl === candidate.url
          ? {
              candidateUrl: candidate.url,
              state: 'error',
              blocked,
              message: blocked
                ? 'TikTok blocks downloading this clip, so it can’t be previewed or used. Pick another clip.'
                : message,
            }
          : p
      );
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
    <section className="card">
      <h2>{JOB_LABEL} Queue</h2>
      {jobs.length === 0 && <p className="muted">No {JOB_LABEL.toLowerCase()}s yet. Upload a product to create one.</p>}
      <ul style={{ listStyle: 'none' }}>
        {jobs.map((job) => {
          const candidates: Candidate[] = job.candidates_json ? JSON.parse(job.candidates_json) : [];
          return (
            <li key={job.id} className="job-item">
              <div className="job-head">
                {editingId === job.id ? (
                  <input
                    type="text"
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={() => rename(job.id, editingName.trim() || `${JOB_LABEL} #${job.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ fontWeight: 600, padding: '2px 8px' }}
                  />
                ) : (
                  <span
                    className="job-name"
                    onClick={() => { setEditingId(job.id); setEditingName(job.name ?? `${JOB_LABEL} #${job.id}`); }}
                    title="Click to rename"
                  >
                    {job.name ?? `${JOB_LABEL} #${job.id}`}
                  </span>
                )}
                <span className={`pill ${STATUS_META[job.status]?.pill ?? 'pill-gray'}`}>
                  {STATUS_META[job.status]?.label ?? job.status}
                </span>
                {AUTO_STATUSES.has(job.status) && <span className="muted small">working…</span>}
                {job.status === 'ready' && job.output_path && (
                  <a href="/ready" className="nav-link small">View →</a>
                )}
                <button
                  onClick={() => { if (confirm(`Delete ${job.name ?? `${JOB_LABEL} #${job.id}`}?`)) removeJob(job.id); }}
                  title="Delete this job"
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1rem' }}
                >
                  🗑
                </button>
              </div>

              {job.status === 'awaiting_approval' && (
                <div style={{ marginTop: '0.75rem' }}>
                  <p style={{ marginBottom: '0.5rem', fontWeight: 600 }}>Choose a viral clip to base the video on:</p>
                  <ul style={{ listStyle: 'none' }}>
                    {candidates.slice(0, 6).map((c, i) => {
                      const blocked = unavailable.has(c.url);
                      return (
                        <li key={i} className={`candidate-row${blocked ? ' unavailable' : ''}`}>
                          {c.coverUrl && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={c.coverUrl}
                              alt="Clip thumbnail"
                              onClick={() => openPreview(c, job.media_type)}
                              style={{ height: 72, borderRadius: 6, cursor: 'pointer' }}
                              title="Click to preview"
                            />
                          )}
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => approve(job.id, i)}
                            disabled={blocked}
                            title={blocked ? 'TikTok blocks downloading this clip, so it can’t be used' : undefined}
                          >
                            Use this
                          </button>
                          {c.relevanceScore != null && (
                            <span
                              title={c.reason}
                              className={`pill ${c.relevanceScore >= 7 ? 'pill-green' : c.relevanceScore >= 5 ? 'pill-amber' : 'pill-red'}`}
                            >
                              {c.relevanceScore}/10
                            </span>
                          )}
                          <span style={{ fontSize: '0.85rem' }}>
                            <span className="mono">{c.views.toLocaleString()} views</span>
                            {c.durationS ? <> · <span className="mono">{c.durationS}s</span></> : null} · {c.platform}
                            {c.title && <> · <em>{c.title.slice(0, 60)}</em></>}
                          </span>
                          {blocked ? (
                            <span className="pill pill-red">download blocked — pick another</span>
                          ) : (
                            <button className="btn btn-ghost btn-sm" onClick={() => openPreview(c, job.media_type)}>
                              Preview
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {job.error && (
                <p className="error-note">
                  <span>Error: {job.error}</span>
                  {job.status === 'failed' && (
                    <button className="btn btn-outline btn-sm" onClick={() => removeJob(job.id)}>
                      Dismiss
                    </button>
                  )}
                </p>
              )}
              <p className="muted small" style={{ marginTop: '0.4rem' }}>
                Updated: {new Date(job.updated_at).toLocaleString()}
              </p>
            </li>
          );
        })}
      </ul>

      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)} role="dialog" aria-label="Clip preview">
          {preview.state === 'loading' && (
            <div style={{ color: '#f4f2f5', textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
              <p style={{ fontSize: '1.05rem', fontWeight: 600 }}>Fetching clip from TikTok…</p>
              <p className="small" style={{ marginTop: 6, opacity: 0.8 }}>
                First view of a clip takes about 30 seconds. After that it opens instantly.
              </p>
            </div>
          )}
          {preview.state === 'ready' && (
            <video
              src={preview.videoUrl}
              controls
              preload="auto"
              onClick={(e) => e.stopPropagation()}
              style={{ width: 340, maxWidth: '92vw', maxHeight: '85vh', borderRadius: 12, background: '#000' }}
            />
          )}
          {preview.state === 'image' && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={preview.imageUrl}
              alt="Photo preview"
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: '92vw', maxHeight: '85vh', borderRadius: 12, background: '#000' }}
            />
          )}
          {preview.state === 'error' && (
            <div style={{ color: '#f4f2f5', textAlign: 'center', maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
              <p style={{ fontWeight: 600 }}>{preview.blocked ? 'This clip can’t be used' : 'Preview failed'}</p>
              <p className="small" style={{ marginTop: 6, opacity: 0.8, overflowWrap: 'anywhere' }}>{preview.message}</p>
              {!preview.blocked && (
                <a href={preview.candidateUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>
                  Watch on TikTok instead
                </a>
              )}
            </div>
          )}
          <p className="lightbox-caption">Click anywhere outside the video to close</p>
        </div>
      )}
    </section>
  );
}
