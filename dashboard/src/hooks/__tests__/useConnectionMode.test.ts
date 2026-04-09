// dashboard/src/hooks/__tests__/useConnectionMode.test.ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConnectionMode } from '../useConnectionMode';
import type { ConnectionMode } from '@/types';

// ── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(latencyHint = 0) {
  vi.mocked(fetch).mockImplementation(() =>
    new Promise(resolve =>
      setTimeout(
        () => resolve({ ok: true, status: 200 } as Response),
        latencyHint,
      ),
    ),
  );
}

function mockFetchStatus(status: number) {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status } as Response);
}

function mockFetchNetworkError() {
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
}

function mockFetchTimeout() {
  // Returns a promise that never resolves so AbortController fires
  vi.mocked(fetch).mockImplementation(
    (_url, init) =>
      new Promise((_, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
        }
      }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useConnectionMode', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  describe('initial state (before refresh)', () => {
    it('starts offline with loading=false', () => {
      const { result } = renderHook(() => useConnectionMode(''));
      expect(result.current.mode).toBe('offline');
      expect(result.current.loading).toBe(false);
      expect(result.current.latencyMs).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('does NOT call fetch on mount', () => {
      renderHook(() => useConnectionMode('ghp_test'));
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── Live mode ─────────────────────────────────────────────────────────────

  describe('live mode', () => {
    it('returns live when the server health check returns 200', async () => {
      mockFetchOk();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.mode).toBe('live');
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('records a non-negative latencyMs in live mode', async () => {
      mockFetchOk();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('probes the correct /api/health endpoint', async () => {
      mockFetchOk();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/health'),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });
  });

  // ── API mode ──────────────────────────────────────────────────────────────

  describe('api mode', () => {
    it('returns api when server is unreachable and PAT is present', async () => {
      mockFetchNetworkError();
      const { result } = renderHook(() => useConnectionMode('ghp_test'));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.mode).toBe('api');
      expect(result.current.latencyMs).toBeNull();
    });

    it('returns api when server returns a non-OK status and PAT is present', async () => {
      mockFetchStatus(503);
      const { result } = renderHook(() => useConnectionMode('ghp_test'));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.mode).toBe('api');
      expect(result.current.error).toMatch(/503/);
    });
  });

  // ── Offline mode ──────────────────────────────────────────────────────────

  describe('offline mode', () => {
    it('returns offline when server unreachable and no PAT', async () => {
      mockFetchNetworkError();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.mode).toBe('offline');
      expect(result.current.latencyMs).toBeNull();
    });
  });

  // ── Timeout handling ──────────────────────────────────────────────────────

  describe('timeout handling', () => {
    it('sets error to "Server probe timed out" and falls through on timeout', async () => {
      mockFetchTimeout();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh();
        // Advance past PROBE_TIMEOUT_MS (2500ms) to trigger AbortController
        vi.advanceTimersByTime(3000);
        await probe;
      });

      expect(result.current.error).toBe('Server probe timed out');
      expect(result.current.mode).toBe('offline'); // no PAT → offline
      expect(result.current.loading).toBe(false);
    });

    it('returns api after timeout when PAT is present', async () => {
      mockFetchTimeout();
      const { result } = renderHook(() => useConnectionMode('ghp_test'));

      await act(async () => {
        const probe = result.current.refresh();
        vi.advanceTimersByTime(3000);
        await probe;
      });

      expect(result.current.mode).toBe('api');
    });
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('sets loading=true while the probe is in flight', async () => {
      // Use a fetch that resolves only after we inspect loading state
      let resolveProbe!: () => void;
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise(resolve => {
            resolveProbe = () => resolve({ ok: true, status: 200 } as Response);
          }),
      );

      const { result } = renderHook(() => useConnectionMode(''));

      // Start the probe but don't await it yet
      let probePromise!: Promise<{ mode: ConnectionMode; latencyMs: number | null }>;
      act(() => {
        probePromise = result.current.refresh();
      });

      expect(result.current.loading).toBe(true);

      // Now let it finish
      await act(async () => {
        resolveProbe();
        vi.runAllTimers();
        await probePromise;
      });

      expect(result.current.loading).toBe(false);
    });
  });

  // ── Refresh with override URL ─────────────────────────────────────────────

  describe('refresh with override URL', () => {
    it('uses the override URL and updates serverUrl state', async () => {
      mockFetchOk();
      const { result } = renderHook(() => useConnectionMode(''));

      await act(async () => {
        const probe = result.current.refresh('https://my-codespace-url.github.dev');
        vi.runAllTimers();
        await probe;
      });

      expect(result.current.serverUrl).toBe('https://my-codespace-url.github.dev');
      expect(fetch).toHaveBeenCalledWith(
        'https://my-codespace-url.github.dev/api/health',
        expect.anything(),
      );
    });
  });

  // ── Error cleared on success ───────────────────────────────────────────────

  describe('error handling', () => {
    it('clears a previous error when refresh succeeds', async () => {
      // First call fails
      mockFetchNetworkError();
      const { result } = renderHook(() => useConnectionMode(''));
      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });
      expect(result.current.error).not.toBeNull();

      // Second call succeeds
      mockFetchOk();
      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        await probe;
      });
      expect(result.current.error).toBeNull();
      expect(result.current.mode).toBe('live');
    });
  });

  // ── refresh() return value ─────────────────────────────────────────────────

  describe('refresh() return value', () => {
    it('returns { mode: "live", latencyMs: number } when server returns 200', async () => {
      mockFetchOk();
      const { result } = renderHook(() => useConnectionMode(''));

      let ret: { mode: ConnectionMode; latencyMs: number | null } | undefined;
      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        ret = await probe;
      });

      expect(ret).toEqual({ mode: 'live', latencyMs: expect.any(Number) });
    });

    it('returns { mode: "api", latencyMs: null } when server unreachable and PAT present', async () => {
      mockFetchNetworkError();
      const { result } = renderHook(() => useConnectionMode('ghp_test'));

      let ret: { mode: ConnectionMode; latencyMs: number | null } | undefined;
      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        ret = await probe;
      });

      expect(ret).toEqual({ mode: 'api', latencyMs: null });
    });

    it('returns { mode: "offline", latencyMs: null } when server unreachable and no PAT', async () => {
      mockFetchNetworkError();
      const { result } = renderHook(() => useConnectionMode(''));

      let ret: { mode: ConnectionMode; latencyMs: number | null } | undefined;
      await act(async () => {
        const probe = result.current.refresh();
        vi.runAllTimers();
        ret = await probe;
      });

      expect(ret).toEqual({ mode: 'offline', latencyMs: null });
    });
  });
});
