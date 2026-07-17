// dashboard/src/context/AuthContext.tsx
/**
 * AuthContext — operator credential store.
 *
 * The operator API token, GitHub PAT, and private key are held ONLY in React
 * state (in-memory). They are NEVER written to localStorage, sessionStorage,
 * cookies, or any other persistence layer. Clearing state (logout or tab
 * close) is the sole mechanism for credential removal.
 *
 * Like octopus ink — used once, then gone.
 */
import React, { createContext, useContext, useState } from 'react';
import type { ConnectionMode } from '@/types';
import {
  DEFAULT_CONTROLLER_ORIGIN,
  normalizeControllerOrigin,
} from '@/lib/controllerUrl';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthState {
  /** Controller credential used only for operator REST/SSE routes. */
  operatorToken: string;
  /** GitHub Personal Access Token used only for direct GitHub API mode. */
  githubPat: string;
  /** Operator's libsodium secret key for decrypting beacon results — in memory only. */
  privkey: string | null;
  /** Current dashboard connection mode. */
  mode: ConnectionMode;
  /** C2 server URL (local or Codespaces-forwarded). */
  serverUrl: string;
  /** Round-trip latency to the C2 server in ms (Live mode only). */
  latencyMs: number | null;
}

export interface AuthLoginInput {
  operatorToken: string;
  githubPat: string;
  mode: ConnectionMode;
  serverUrl: string;
  latencyMs: number | null;
  privkey?: string | null;
}

interface AuthContextValue extends AuthState {
  /** Store role-separated credentials and connection state in memory. */
  login: (input: AuthLoginInput) => void;
  /** Set or update the operator private key after initial login. */
  setPrivkey: (key: string) => void;
  /** Clear all credentials and reset to offline state. */
  logout: () => void;
  /** True when the current non-offline mode has its required credential. */
  isAuthenticated: boolean;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

const INITIAL_STATE: AuthState = {
  operatorToken: '',
  githubPat:     '',
  privkey:       null,
  mode:          'api',
  serverUrl:     DEFAULT_CONTROLLER_ORIGIN,
  latencyMs:     null,
};

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);

  function login(input: AuthLoginInput) {
    setState({
      operatorToken: input.operatorToken,
      githubPat:     input.githubPat,
      privkey:       input.privkey ?? null,
      mode:          input.mode,
      serverUrl:     normalizeControllerOrigin(input.serverUrl),
      latencyMs:     input.latencyMs,
    });
  }

  function setPrivkey(key: string) {
    setState(prev => ({ ...prev, privkey: key }));
  }

  function logout() {
    setState(prev => ({
      operatorToken: '',
      githubPat:     '',
      privkey:       null,
      mode:          'offline',
      serverUrl:     prev.serverUrl,
      latencyMs:     null,
    }));
  }

  const isAuthenticated =
    state.mode === 'live'
      ? state.operatorToken.length > 0
      : state.mode === 'api'
        ? state.githubPat.length > 0
        : false;

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
