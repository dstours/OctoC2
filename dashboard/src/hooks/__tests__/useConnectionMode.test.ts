import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { useConnectionMode } from '../useConnectionMode';

const nativeFetch = globalThis.fetch;
type FetchCall = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock = vi.fn<FetchCall>();

function response(ok: boolean, status: number, body: unknown = {}) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('useConnectionMode', () => {
  beforeEach(() => {
    fetchMock = vi.fn<FetchCall>();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts offline and does not probe on mount', () => {
    const { result } = renderHook(() => useConnectionMode('', ''));
    expect(result.current).toMatchObject({
      mode: 'offline',
      loading: false,
      latencyMs: null,
      error: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enters live mode only after health and operator authentication succeed', async () => {
    fetchMock
      .mockResolvedValueOnce(response(true, 200))
      .mockResolvedValueOnce(response(true, 200));
    const { result } = renderHook(() =>
      useConnectionMode('operator-secret', 'ghp_fallback'),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.mode).toBe('live');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://127.0.0.1:8080/api/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://127.0.0.1:8080/api/beacons',
      expect.objectContaining({
        headers: { Authorization: 'Bearer operator-secret' },
        signal: expect.anything(),
      }),
    );
  });

  it('never sends the GitHub PAT to controller endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(response(true, 200))
      .mockResolvedValueOnce(response(true, 200));
    const { result } = renderHook(() =>
      useConnectionMode('operator-token', 'ghp_must_not_cross_roles'),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      'ghp_must_not_cross_roles',
    );
  });

  it('requires an operator token even when health is public and a GitHub PAT exists', async () => {
    fetchMock.mockResolvedValueOnce(response(true, 200));
    const { result } = renderHook(() => useConnectionMode('', 'ghp_direct'));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.mode).toBe('api');
    expect(result.current.error).toMatch(/operator api token required/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to direct GitHub mode when operator authentication fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response(true, 200))
      .mockResolvedValueOnce(response(false, 401));
    const { result } = renderHook(() =>
      useConnectionMode('bad-operator-token', 'ghp_direct'),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.mode).toBe('api');
    expect(result.current.error).toMatch(/authentication failed.*401/i);
  });

  it('falls back offline when the controller is unreachable and no GitHub PAT exists', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useConnectionMode('operator-token', ''));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.mode).toBe('offline');
    expect(result.current.error).toBe('Server unreachable');
  });

  it('uses an override URL without changing credential roles', async () => {
    fetchMock
      .mockResolvedValueOnce(response(true, 200))
      .mockResolvedValueOnce(response(true, 200));
    const { result } = renderHook(() => useConnectionMode('operator-token', ''));

    await act(async () => {
      await result.current.refresh('https://private.example.test');
    });

    expect(result.current.serverUrl).toBe('https://private.example.test');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://private.example.test/api/health',
      expect.anything(),
    );
  });

  it('rejects unsafe override URLs before any request or bearer token is sent', async () => {
    const { result } = renderHook(() =>
      useConnectionMode('operator-secret', 'ghp_fallback'),
    );
    const invalidUrls = [
      'http://controller.example',
      'https://operator:secret@controller.example',
      'https://controller.example?target=attacker',
      'https://controller.example/proxy',
    ];

    for (const invalidUrl of invalidUrls) {
      await act(async () => {
        const detected = await result.current.refresh(invalidUrl);
        expect(detected.mode).toBe('api');
      });
    }

    expect(result.current.serverUrl).toBe('https://127.0.0.1:8080');
    expect(result.current.error).toMatch(/pathless HTTPS origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a stalled probe and falls back to direct GitHub mode', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const { result } = renderHook(() => useConnectionMode('', 'ghp_direct'));

    let probe!: Promise<unknown>;
    act(() => {
      probe = result.current.refresh();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
      await probe;
    });

    expect(result.current.mode).toBe('api');
    expect(result.current.error).toBe('Server probe timed out');
  });
});
