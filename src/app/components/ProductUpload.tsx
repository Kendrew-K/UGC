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

export function ProductUpload({ onJobCreated }: { onJobCreated?: () => void } = {}) {
  const [result, setResult] = useState<any>(null);
  const [faceMode, setFaceMode] = useState<'upload' | 'generate' | 'saved'>('upload');
  const [faceB64, setFaceB64] = useState<string | null>(null);
  const [faceName, setFaceName] = useState<string | null>(null);
  const [facePrompt, setFacePrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAvatarPath, setSavedAvatarPath] = useState<string | null>(null);
  const [avatarOptions, setAvatarOptions] = useState<string[] | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch('/api/avatar')
      .then((r) => r.json())
      .then((d) => {
        setSavedAvatarPath(d.path);
        if (d.path) setFaceMode('saved');
      });
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

  const faceReady = faceMode === 'upload' ? !!faceB64 : faceMode === 'saved' ? !!savedAvatarPath : facePrompt.trim().length > 0 && !avatarOptions;

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
      };
      if (faceMode === 'upload') {
        body.faceImageBase64 = faceB64;
      } else if (faceMode === 'saved') {
        const avatarRes = await fetch('/' + savedAvatarPath);
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
      const note = faceMode === 'generate' ? ' (generating avatar first…)' : '';
      setStatus(`${JOB_LABEL} #${data.jobIds?.[0]} started${note} — it will run automatically and pause for you to pick a clip in the ${JOB_LABEL} Queue below.`);
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
      <section style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px', color: '#171717' }}>
        <p style={{ color: '#2e7d32', marginBottom: '1rem' }}>{status}</p>
        <button
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
          style={{ padding: '8px 16px', fontWeight: 600, cursor: 'pointer', background: '#0070f3', color: '#fff', border: 'none', borderRadius: '6px' }}
        >
          Start another job
        </button>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: '2rem', padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px', color: '#171717' }}>
      <h2 style={{ marginTop: 0 }}>1. Upload product photo</h2>
      <input type="file" accept="image/*" onChange={onProductFile} disabled={busy} />

      {status && (
        <p style={{ color: error ? 'red' : busy ? '#0070f3' : '#2e7d32', marginTop: '0.75rem' }}>
          {busy && <span aria-hidden style={{ marginRight: 6 }}>⏳</span>}
          {status}
        </p>
      )}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}

      {result && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#f5f5f5', borderRadius: '6px', color: '#171717' }}>
          <p><strong>Type:</strong> {result.classification?.type}</p>
          <p><strong>Industry:</strong> {result.classification?.industry}</p>
          <p><strong>Keywords:</strong> {result.classification?.keywords?.join(', ')}</p>
          {result.remembered
            ? <p style={{ color: 'green' }}>We remember this product — using saved answers</p>
            : <p>New product.</p>}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '1.5rem' }}>
          <h2 style={{ marginTop: 0 }}>2. Choose face</h2>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            {(savedAvatarPath ? (['saved', 'upload', 'generate'] as const) : (['upload', 'generate'] as const)).map((mode) => (
              <button
                key={mode}
                onClick={() => { setFaceMode(mode); setFaceB64(null); setFaceName(null); setFacePrompt(''); setAvatarOptions(null); }}
                disabled={busy}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: '1px solid #0070f3',
                  background: faceMode === mode ? '#0070f3' : '#fff',
                  color: faceMode === mode ? '#fff' : '#0070f3',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
              >
                {mode === 'upload' ? 'Upload photo' : mode === 'generate' ? 'Create a new avatar' : 'Use saved avatar'}
              </button>
            ))}
          </div>

          {faceMode === 'upload' && (
            <div>
              <input type="file" accept="image/*" onChange={onFaceFile} disabled={busy} />
              {faceName && <span style={{ marginLeft: 8, color: '#2e7d32' }}>✓ {faceName}</span>}
            </div>
          )}

          {faceMode === 'saved' && savedAvatarPath && (
            <div>
              <img src={'/' + savedAvatarPath} alt="Saved avatar" style={{ width: 120, borderRadius: 8 }} />
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
                style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #ccc', fontFamily: 'inherit', resize: 'vertical' }}
              />
              <button
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
                style={{ marginTop: '0.5rem', padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#0070f3', color: '#fff', cursor: 'pointer' }}
              >
                {avatarBusy ? 'Generating…' : 'Generate options'}
              </button>
              <p style={{ fontSize: '0.8rem', color: '#666', margin: '4px 0 0' }}>
                Generates 3 options to choose from (adds ~2 min). Your choice is saved and reused for future videos.
              </p>

              {avatarOptions && (
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                  {avatarOptions.map((p) => (
                    <div key={p} style={{ textAlign: 'center' }}>
                      <img src={'/' + p} alt="Avatar option" style={{ width: 100, borderRadius: 8, display: 'block' }} />
                      <button
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
                            setSavedAvatarPath(data.path);
                            setAvatarOptions(null);
                            setFaceMode('saved');
                          } catch (err: any) {
                            setError(err.message ?? 'Could not save avatar choice');
                          } finally {
                            setAvatarBusy(false);
                          }
                        }}
                        disabled={avatarBusy}
                        style={{ marginTop: 4, padding: '2px 8px', fontSize: '0.75rem', borderRadius: 4, border: 'none', background: '#0070f3', color: '#fff', cursor: 'pointer' }}
                      >
                        Use this
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: '1rem' }}>
            <button
              onClick={start}
              disabled={busy || !faceReady}
              style={{
                padding: '8px 16px',
                fontWeight: 600,
                cursor: busy || !faceReady ? 'not-allowed' : 'pointer',
                background: !faceReady ? '#ccc' : '#0070f3',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
              }}
            >
              Generate video
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
