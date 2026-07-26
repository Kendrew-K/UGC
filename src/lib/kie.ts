/**
 * KIE.AI shared plumbing — one submit-and-poll helper for every KIE-hosted
 * model (WAN video swap, nano-banana image edits) plus file upload.
 * KIE mirrors fal's model catalog behind a single jobs API, so this is the
 * whole integration surface.
 * Owns: createTask/recordInfo lifecycle, base64 file upload.
 * Does NOT: know about products, jobs, or prompts.
 */
import fs from 'node:fs';
import path from 'node:path';

const API_BASE = 'https://api.kie.ai';
// File uploads live on a separate host — api.kie.ai 404s the upload path
// (confirmed live 2026-07-07); docs' "Server: api.kie.ai" is wrong for files.
const UPLOAD_BASE = 'https://kieai.redpandaai.co';

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export type KieTaskOpts = {
  /** Poll interval in ms (default 5s). */
  pollIntervalMs?: number;
  /** Give up after this many polls (default 720 ≈ 60 min — WAN video swaps run 30-50 min). */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Submits one KIE job and polls until it succeeds, returning the first
 * result URL. Poll fetches tolerate transient network failures (the same
 * dropped-connection class that once killed a billed 49-minute fal swap).
 */
export async function runKieTask(
  model: string,
  input: Record<string, unknown>,
  opts: KieTaskOpts = {}
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollIntervalMs ?? 5000;
  const maxAttempts = opts.maxAttempts ?? 720;

  const submitRes = await f(`${API_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, input }),
  });
  if (!submitRes.ok) {
    const detail = await submitRes.text().catch(() => '');
    throw new Error(`KIE ${model} submit failed: ${submitRes.status} ${detail.slice(0, 200)}`);
  }
  const submitData = (await submitRes.json()) as { data?: { taskId?: string }; msg?: string };
  const taskId = submitData.data?.taskId;
  if (!taskId) throw new Error(`KIE ${model}: no taskId in response (${submitData.msg ?? 'no message'})`);
  console.log(`[kie] submitted ${model} taskId=${taskId}`);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    let d: { state: string; resultJson?: string; failMsg?: string } | undefined;
    try {
      const pollRes = await f(`${API_BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: authHeaders() });
      if (!pollRes.ok) continue; // transient 5xx/429 — poll again
      d = ((await pollRes.json()) as { data?: typeof d }).data;
    } catch {
      continue; // dropped connection — the job keeps running server-side
    }
    if (d?.state === 'success') {
      const result = JSON.parse(d.resultJson ?? '{}') as { resultUrls?: string[] };
      const url = result.resultUrls?.[0];
      if (!url) throw new Error(`KIE ${model}: no result URL in success payload`);
      return url;
    }
    if (d?.state === 'fail') throw new Error(`KIE ${model} failed: ${d.failMsg ?? 'unknown'}`);
  }
  throw new Error(`KIE ${model} timed out after ${Math.round((maxAttempts * pollMs) / 60000)} min`);
}

/** Uploads a local file to KIE storage and returns its public download URL. */
export async function kieUpload(localPath: string, deps: { fetchImpl?: typeof fetch } = {}): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(`${UPLOAD_BASE}/api/file-base64-upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      base64Data: fs.readFileSync(localPath).toString('base64'),
      uploadPath: 'ugc-creator',
      fileName: path.basename(localPath),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`KIE upload failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: { downloadUrl?: string }; msg?: string };
  if (!data.data?.downloadUrl) throw new Error(`KIE upload: no downloadUrl (${data.msg ?? 'no message'})`);
  return data.data.downloadUrl;
}
