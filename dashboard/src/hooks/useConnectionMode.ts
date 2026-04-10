// dashboard/src/hooks/useConnectionMode.ts
import { useState, useCallback } from 'react';
import type { ConnectionMode } from '@/types';
import { setGitHubCoords } from '@/lib/coords';

/** How long to wait for the C2 server health probe before giving up (ms). */
const PROBE_TIMEOUT_MS = 2500;

const DEFAULT_SERVER =
  (import.meta.env['VITE_C2_SERVER_URL'] as string | undefined) ??
  'http://localhost:8080';

export interface ConnectionModeResult {
  /** The detected connection mode. */
  mode: ConnectionMode;
  /** Round-trip latency to the C2 server. Only set when mode === 'live'. */
  latencyMs: number | null;
  /** The server URL that was probed. */
  serverUrl: string;
  /** True while the probe is in flight. */
  loading: boolean;
  /** Any error encountered during probing (non-fatal — mode is still set). */
  error: string | null;
  /**
   * Re-run the probe. Pass a new serverUrl to override the default
   * (e.g. when the operator pastes a Codespaces forwarding URL).
   */
  refresh: (overrideServerUrl?: string) => Promise<{ mode: ConnectionMode; latencyMs: number | null }>;
}

/**
 * Detects the appropriate connection mode by probing the C2 server.
 *
 * Detection order:
 *   1. GET /api/health on serverUrl → 200 OK  →  mode = 'live'
 *   2. pat.length > 0                          →  mode = 'api'
 *   3. fallback                                →  mode = 'offline'
 *
 * The probe is NOT run automatically on mount — call refresh() explicitly
 * (the LoginPage calls it on submit). This keeps the hook pure and testable
 * without side-effects during render.
 *
 * Like a tentacle feeling for a safe path before the octopus commits.
 */
export function useConnectionMode(pat: string): ConnectionModeResult {
  const [mode, setMode]           = useState<ConnectionMode>('offline');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER);

  const refresh = useCallback(
    async (overrideServerUrl?: string): Promise<{ mode: ConnectionMode; latencyMs: number | null }> => {
      const url = overrideServerUrl ?? serverUrl;
      if (overrideServerUrl) setServerUrl(overrideServerUrl);

      setLoading(true);
      setError(null);

      // ── Step 1: probe the C2 server ────────────────────────────────────────
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const t0 = performance.now();

        const res = await fetch(`${url}/api/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const ms = Math.round(performance.now() - t0);
          // Cache repo coords from health response for settings/display
          try {
            const data = await res.json() as { owner?: string; repo?: string };
            if (data.owner && data.repo) setGitHubCoords(data.owner, data.repo);
          } catch { /* ignore parse errors */ }
          setLatencyMs(ms);
          setMode('live');
          setLoading(false);
          return { mode: 'live', latencyMs: ms };
        }
        // Non-OK response from the server (e.g. 503) — fall through
        clearTimeout(timeout);
        setError(`Server responded with ${res.status}`);
      } catch (err) {
        // AbortError = timeout; TypeError = network unreachable
        // Check both instanceof Error and DOMException since jsdom may differ
        const errName = (err instanceof Error || err instanceof DOMException)
          ? err.name
          : (err as { name?: string })?.name;
        const isTimeout = errName === 'AbortError';
        setError(isTimeout ? 'Server probe timed out' : 'Server unreachable');
      }

      // ── Step 2: PAT present → API mode ────────────────────────────────────
      if (pat.length > 0) {
        setLatencyMs(null);
        setMode('api');
        setLoading(false);
        return { mode: 'api', latencyMs: null };
      }

      // ── Step 3: Offline ────────────────────────────────────────────────────
      setLatencyMs(null);
      setMode('offline');
      setLoading(false);
      return { mode: 'offline', latencyMs: null };
    },
    [pat, serverUrl],
  );

  return { mode, latencyMs, serverUrl, loading, error, refresh };
}
