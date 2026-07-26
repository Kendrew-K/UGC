'use client';
import { useState, useEffect } from 'react';
import { JOB_LABEL } from '@/lib/config';

async function fileToBase64(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Full-screen viewer for an avatar option; click toggles zoom, Esc or
 * clicking the backdrop closes. Kept dependency-free on purpose. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Avatar preview">
      <img
        src={src}
        alt="Avatar option, enlarged"
        className={zoomed ? 'zoomed' : ''}
        onClick={(e) => { e.stopPropagation(); setZoomed(!zoomed); }}
      />
      <p className="lightbox-caption">
        Click the photo to zoom. Judge the person&rsquo;s look — the background is discarded in the final video.
      </p>
    </div>
  );
}

export function ProductUpload({ onJobCreated }: { onJobCreated?: () => void } = {}) {
  const [result, setResult] = useState<any>(null);
  const [faceMode, setFaceMode] = useState<'upload' | 'generate' | 'saved'>('upload');
  const [mediaType, setMediaType] = useState<'video' | 'picture'>('video');
  const [faceB64, setFaceB64] = useState<string | null>(null);
  const [faceName, setFaceName] = useState<string | null>(null);
  const [facePrompt, setFacePrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAvatars, setSavedAvatars] = useState<string[]>([]);
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(null);
  const [avatarOptions, setAvatarOptions] = useState<string[] | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/avatar')
      .then((r) => r.json())
      .then((d) => {
        setSavedAvatars(d.all ?? (d.path ? [d.path] : []));
        setSelectedAvatar(d.path ?? null);
        if (d.path) setFaceMode('saved');
      })
      .catch(() => {});
  }, []);

  async function onProductFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStatus('Classifying product…');
      const b64 = await fileToBase64(file);
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientName: 'Me', imageBase64: b64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Classification failed');
      setResult(data);
      setStatus('Classified. Now add a face photo to generate the video.');
    } catch (err: any) {
      setError(err.message ?? 'Unknown error');
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function onFaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFaceB64(await fileToBase64(file));
    setFaceName(file.name);
  }

  const faceReady = faceMode === 'upload' ? !!faceB64 : faceMode === 'saved' ? !!selectedAvatar : false;

  async function start() {
    if (!result?.productId || !faceReady) return;
    setBusy(true);
    setError(null);
    try {
      setStatus('Creating video job…');
      const body: Record<string, unknown> = {
        productId: result.productId,
        count: 1,
        answers: result.remembered ?? undefined,
        mediaType,
      };
      if (faceMode === 'upload') {
        body.faceImageBase64 = faceB64;
      } else if (faceMode === 'saved') {
        const avatarRes = await fetch('/' + selectedAvatar);
        const avatarBuf = await avatarRes.arrayBuffer();
        const bytes = new Uint8Array(avatarBuf);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        body.faceImageBase64 = btoa(binary);
      } else {
        body.facePrompt = facePrompt.trim();
      }
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create job');
      setStatus(`${JOB_LABEL} #${data.jobIds?.[0]} started — it will run automatically and pause for you to pick a clip in the ${JOB_LABEL} Queue below.`);
      onJobCreated?.();
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message ?? 'Unknown error');
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <section className="card">
        <p style={{ color: '#1f7a35', marginBottom: '1rem' }}>{status}</p>
        <button
          className="btn btn-primary"
          onClick={() => {
            setSubmitted(false);
            setResult(null);
            setFaceB64(null);
            setFaceName(null);
            setFacePrompt('');
            setAvatarOptions(null);
            setStatus(null);
            setError(null);
          }}
        >
          Start another job
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="step-label"><span className="step-num">1</span> Upload product photo</h2>
      <input type="file" accept="image/*" onChange={onProductFile} disabled={busy} />

      {status && (
        <p style={{ color: error ? '#b3261e' : busy ? 'var(--accent)' : '#1f7a35', marginTop: '0.75rem' }}>
          {busy && <span aria-hidden style={{ marginRight: 6 }}>⏳</span>}
          {status}
        </p>
      )}
      {error && <p className="error-note">Error: {error}</p>}

      {result && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--line)' }}>
          <p><strong>Type:</strong> {result.classification?.type}</p>
          <p><strong>Industry:</strong> {result.classification?.industry}</p>
          <p><strong>Keywords:</strong> {result.classification?.keywords?.join(', ')}</p>
          {result.remembered
            ? <p style={{ color: '#1f7a35' }}>We remember this product — using saved answers</p>
            : <p className="muted">New product.</p>}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '1.5rem' }}>
          <h2 className="step-label"><span className="step-num">2</span> Choose face</h2>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {(savedAvatars.length > 0 ? (['saved', 'upload', 'generate'] as const) : (['upload', 'generate'] as const)).map((mode) => (
              <button
                key={mode}
                onClick={() => { setFaceMode(mode); setFaceB64(null); setFaceName(null); setFacePrompt(''); setAvatarOptions(null); }}
                disabled={busy}
                className={`btn btn-outline${faceMode === mode ? ' selected' : ''}`}
              >
                {mode === 'upload' ? 'Upload photo' : mode === 'generate' ? 'Create a new avatar' : 'Use a saved avatar'}
              </button>
            ))}
          </div>

          {faceMode === 'upload' && (
            <div>
              <input type="file" accept="image/*" onChange={onFaceFile} disabled={busy} />
              {faceName && <span style={{ marginLeft: 8, color: '#1f7a35' }}>✓ {faceName}</span>}
            </div>
          )}

          {faceMode === 'saved' && savedAvatars.length > 0 && (
            <div>
              <p className="muted small" style={{ marginBottom: '0.25rem' }}>
                Click an avatar to use it for this video. Click 🔍 to see it up close.
              </p>
              <div className="avatar-grid" style={{ marginTop: '0.5rem' }}>
                {savedAvatars.map((p) => (
                  <div key={p} className="avatar-option">
                    <img
                      src={'/' + p}
                      alt="Saved avatar"
                      onClick={() => setSelectedAvatar(p)}
                      style={{
                        cursor: 'pointer',
                        outline: selectedAvatar === p ? '3px solid var(--accent)' : 'none',
                        outlineOffset: 2,
                      }}
                    />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 6, alignItems: 'center' }}>
                      {selectedAvatar === p ? (
                        <span className="pill pill-green">selected</span>
                      ) : (
                        <button className="btn btn-outline btn-sm" onClick={() => setSelectedAvatar(p)}>Select</button>
                      )}
                      <button
                        className="btn btn-outline btn-sm"
                        title="View up close"
                        onClick={() => setLightboxSrc('/' + p)}
                      >
                        🔍
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {faceMode === 'generate' && (
            <div>
              <textarea
                rows={3}
                placeholder="Describe the avatar, e.g. 'Young Indonesian woman, natural makeup, friendly smile, studio lighting'"
                value={facePrompt}
                onChange={(e) => setFacePrompt(e.target.value)}
                disabled={busy || avatarBusy}
                style={{ width: '100%', resize: 'vertical' }}
              />
              <button
                className="btn btn-primary"
                onClick={async () => {
                  setAvatarBusy(true);
                  setError(null);
                  try {
                    const res = await fetch('/api/avatar/generate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ prompt: facePrompt.trim() }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error ?? 'Avatar generation failed');
                    setAvatarOptions(data.paths);
                  } catch (err: any) {
                    setError(err.message ?? 'Avatar generation failed');
                  } finally {
                    setAvatarBusy(false);
                  }
                }}
                disabled={busy || avatarBusy || !facePrompt.trim()}
                style={{ marginTop: '0.5rem' }}
              >
                {avatarBusy ? 'Generating…' : 'Generate options'}
              </button>
              <p className="muted small" style={{ marginTop: 4 }}>
                Generates 3 options to choose from (adds ~2 min). Your choice is saved and reused for future videos.
              </p>

              {avatarOptions && (
                <>
                  <p className="muted small" style={{ marginTop: '0.75rem' }}>
                    Click a photo to see it up close. Only the person matters — the background isn&rsquo;t used.
                  </p>
                  <div className="avatar-grid">
                    {avatarOptions.map((p) => (
                      <div key={p} className="avatar-option">
                        <img src={'/' + p} alt="Avatar option" onClick={() => setLightboxSrc('/' + p)} />
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: 6 }}
                          onClick={async () => {
                            setAvatarBusy(true);
                            try {
                              const res = await fetch('/api/avatar/choose', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chosenPath: p }),
                              });
                              const data = await res.json();
                              if (!res.ok) throw new Error(data.error ?? 'Could not save avatar choice');
                              setSavedAvatars((prev) => [data.path, ...prev]);
                              setSelectedAvatar(data.path);
                              setAvatarOptions(null);
                              setFaceMode('saved');
                            } catch (err: any) {
                              setError(err.message ?? 'Could not save avatar choice');
                            } finally {
                              setAvatarBusy(false);
                            }
                          }}
                          disabled={avatarBusy}
                        >
                          Use this
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ marginTop: '1.25rem' }}>
            <h2 className="step-label"><span className="step-num">3</span> What to create</h2>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              {(['video', 'picture'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setMediaType(t)}
                  disabled={busy}
                  className={`btn btn-outline${mediaType === t ? ' selected' : ''}`}
                >
                  {t === 'video' ? '🎬 Video' : '🖼 Picture'}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" onClick={start} disabled={busy || !faceReady}>
              {mediaType === 'video' ? 'Generate video' : 'Generate picture'}
            </button>
          </div>
        </div>
      )}

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </section>
  );
}
