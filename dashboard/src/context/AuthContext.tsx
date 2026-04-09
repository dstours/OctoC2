// dashboard/src/context/AuthContext.tsx
/**
 * AuthContext — operator credential store.
 *
 * The PAT and private key are held ONLY in React state (in-memory).
 * They are NEVER written to localStorage, sessionStorage, cookies,
 * or any other persistence layer. Clearing state (logout or tab close)
 * is the sole mechanism for credential removal.
 *
 * Like octopus ink — used once, then gone.
 */
import React, { createContext, useContext, useState } from 'react';
import type { ConnectionMode } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthState {
  /** GitHub Personal Access Token — in memory only. */
  pat: string;
  /** Operator's libsodium secret key for decrypting beacon results — in memory only. */
  privkey: string | null;
  /** Current dashboard connection mode. */
  mode: ConnectionMode;
  /** C2 server URL (local or Codespaces-forwarded). */
  serverUrl: string;
  /** Round-trip latency to the C2 server in ms (Live mode only). */
  latencyMs: number | null;
}

interface AuthContextValue extends AuthState {
  /**
   * Authenticate the operator. Stores PAT and (optionally) privkey in memory.
   * Determines connection mode and server URL from the connection probe result.
   */
  login: (
    pat: string,
    mode: ConnectionMode,
    serverUrl: string,
    latencyMs: number | null,
    privkey?: string | null,
  ) => void;
  /** Set or update the operator private key after initial login. */
  setPrivkey: (key: string) => void;
  /** Clear all credentials and reset to offline state. */
  logout: () => void;
  /** True when the operator has a valid PAT set. */
  isAuthenticated: boolean;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

const DEFAULT_SERVER =
  (import.meta.env['VITE_C2_SERVER_URL'] as string | undefined) ??
  'http://localhost:8080';

const INITIAL_STATE: AuthState = {
  pat:       '',
  privkey:   null,
  mode:      'offline',
  serverUrl: DEFAULT_SERVER,
  latencyMs: null,
};

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  function login(
    pat: string,
    mode: ConnectionMode,
    serverUrl: string,
    latencyMs: number | null,
    privkey: string | null = null,
  ) {
    setState({ pat, privkey, mode, serverUrl, latencyMs });
  }

  function setPrivkey(key: string) {
    setState(prev => ({ ...prev, privkey: key }));
  }

  function logout() {
    setState(prev => ({
      pat:       '',
      privkey:   null,
      mode:      'offline',
      serverUrl: prev.serverUrl,
      latencyMs: null,
    }));
  }

  const isAuthenticated = state.pat.length > 0;

  return (
    <AuthContext.Provider value={{ ...state, login, setPrivkey, logout, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
