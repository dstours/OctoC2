import { useCallback, useState } from 'react';
import type { ConnectionMode } from '@/types';
import { setGitHubCoords } from '@/lib/coords';
import {
  DEFAULT_CONTROLLER_ORIGIN,
  normalizeControllerOrigin,
} from '@/lib/controllerUrl';

const PROBE_TIMEOUT_MS = 2500;

export interface ConnectionModeResult {
  mode: ConnectionMode;
  latencyMs: number | null;
  serverUrl: string;
  loading: boolean;
  error: string | null;
  refresh: (
    overrideServerUrl?: string,
  ) => Promise<{ mode: ConnectionMode; latencyMs: number | null }>;
}

/**
 * Select a connection mode without crossing credential roles.
 *
 * Live mode requires both a reachable controller and an operator token that
 * is accepted by an operator-only endpoint. Direct GitHub API mode uses only
 * the GitHub PAT. Neither credential is substituted for the other.
 */
export function useConnectionMode(
  operatorToken: string,
  githubPat: string,
): ConnectionModeResult {
  const [mode, setMode] = useState<ConnectionMode>('offline');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_CONTROLLER_ORIGIN);

  const refresh = useCallback(
    async (
      overrideServerUrl?: string,
    ): Promise<{ mode: ConnectionMode; latencyMs: number | null }> => {
      const settleFallback = (): {
        mode: ConnectionMode;
        latencyMs: number | null;
      } => {
        setLatencyMs(null);
        setLoading(false);
        if (githubPat.length > 0) {
          setMode('api');
          return { mode: 'api', latencyMs: null };
        }
        setMode('offline');
        return { mode: 'offline', latencyMs: null };
      };

      setLoading(true);
      setError(null);

      let url: string;
      try {
        url = normalizeControllerOrigin(overrideServerUrl ?? serverUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invalid controller URL');
        return settleFallback();
      }
      if (overrideServerUrl !== undefined) setServerUrl(url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const startedAt = performance.now();

      try {
        const health = await fetch(`${url}/api/health`, {
          signal: controller.signal,
        });

        if (!health.ok) {
          setError(`Server responded with ${health.status}`);
          return settleFallback();
        }

        try {
          const data = await health.json() as { owner?: string; repo?: string };
          if (data.owner && data.repo) setGitHubCoords(data.owner, data.repo);
        } catch {
          // Repository coordinates are optional health metadata.
        }

        if (operatorToken.length === 0) {
          setError('Operator API token required for live mode');
          return settleFallback();
        }

        const authenticated = await fetch(`${url}/api/beacons`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
          signal: controller.signal,
        });

        if (!authenticated.ok) {
          setError(`Operator authentication failed (${authenticated.status})`);
          return settleFallback();
        }

        const ms = Math.round(performance.now() - startedAt);
        setLatencyMs(ms);
        setMode('live');
        setLoading(false);
        return { mode: 'live', latencyMs: ms };
      } catch (err) {
        const errName = (err instanceof Error || err instanceof DOMException)
          ? err.name
          : (err as { name?: string })?.name;
        setError(
          errName === 'AbortError'
            ? 'Server probe timed out'
            : 'Server unreachable',
        );
        return settleFallback();
      } finally {
        clearTimeout(timeout);
      }
    },
    [githubPat, operatorToken, serverUrl],
  );

  return { mode, latencyMs, serverUrl, loading, error, refresh };
}
