import { describe, it, expect } from 'vitest';
import { runKieTask, kieUpload } from './kie';

type FetchImpl = typeof fetch;

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('runKieTask', () => {
  it('submits then polls until success, returning the first result URL', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('createTask')) return jsonResponse({ data: { taskId: 't1' } });
      return jsonResponse({ data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://kie/out.mp4'] }) } });
    };
    const out = await runKieTask('wan/2-2-animate-replace', { video_url: 'v' }, { fetchImpl, pollIntervalMs: 1 });
    expect(out).toBe('https://kie/out.mp4');
    expect(calls[0]).toContain('createTask');
    expect(calls[1]).toContain('recordInfo?taskId=t1');
  });

  it('surfaces KIE failMsg on failed tasks', async () => {
    const fetchImpl: FetchImpl = async (url) =>
      String(url).includes('createTask')
        ? jsonResponse({ data: { taskId: 't2' } })
        : jsonResponse({ data: { state: 'fail', failMsg: 'content rejected' } });
    await expect(runKieTask('m', {}, { fetchImpl, pollIntervalMs: 1 })).rejects.toThrow(/content rejected/);
  });

  it('keeps polling through transient network failures instead of dying', async () => {
    let polls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (String(url).includes('createTask')) return jsonResponse({ data: { taskId: 't3' } });
      polls++;
      if (polls < 3) throw new Error('fetch failed'); // the class of error that killed a 49-min fal swap
      return jsonResponse({ data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['u'] }) } });
    };
    await expect(runKieTask('m', {}, { fetchImpl, pollIntervalMs: 1 })).resolves.toBe('u');
  });

  it('throws with detail when submit is rejected', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ msg: 'insufficient credits' }, false, 402);
    await expect(runKieTask('m', {}, { fetchImpl })).rejects.toThrow(/402.*insufficient credits/);
  });

  it('times out after maxAttempts', async () => {
    const fetchImpl: FetchImpl = async (url) =>
      String(url).includes('createTask')
        ? jsonResponse({ data: { taskId: 't4' } })
        : jsonResponse({ data: { state: 'running' } });
    await expect(runKieTask('m', {}, { fetchImpl, pollIntervalMs: 1, maxAttempts: 3 })).rejects.toThrow(/timed out/);
  });
});

describe('kieUpload', () => {
  it('posts base64 payload and returns the download URL', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ data: { downloadUrl: 'https://kie/file.jpg' } });
    };
    // package.json is a handy small real file to base64
    const out = await kieUpload('package.json', { fetchImpl });
    expect(out).toBe('https://kie/file.jpg');
    expect(body.fileName).toBe('package.json');
    expect(typeof body.base64Data).toBe('string');
    expect((body.base64Data as string).length).toBeGreaterThan(0);
  });

  it('throws with detail when the upload is rejected', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ msg: 'quota exceeded' }, false, 429);
    await expect(kieUpload('package.json', { fetchImpl })).rejects.toThrow(/429.*quota exceeded/);
  });
});
