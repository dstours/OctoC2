import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { AuthProvider, useAuth } from '../AuthContext';
import type { ConnectionMode } from '@/types';

function StateDisplay() {
  const {
    operatorToken,
    githubPat,
    privkey,
    mode,
    serverUrl,
    latencyMs,
    isAuthenticated,
  } = useAuth();
  return (
    <div data-testid="state">
      {JSON.stringify({
        operatorToken,
        githubPat,
        privkey: privkey ? '[SET]' : null,
        mode,
        serverUrl,
        latencyMs,
        isAuthenticated,
      })}
    </div>
  );
}

function LoginButton({
  mode,
  operatorToken = '',
  githubPat = '',
  privkey = null,
}: {
  mode: ConnectionMode;
  operatorToken?: string;
  githubPat?: string;
  privkey?: string | null;
}) {
  const { login } = useAuth();
  return (
    <button
      onClick={() => login({
        operatorToken,
        githubPat,
        privkey,
        mode,
        serverUrl: 'https://127.0.0.1:8080',
        latencyMs: mode === 'live' ? 5 : null,
      })}
    >
      login
    </button>
  );
}

function LogoutButton() {
  const { logout } = useAuth();
  return <button onClick={logout}>logout</button>;
}

function SetPrivkeyButton() {
  const { setPrivkey } = useAuth();
  return <button onClick={() => setPrivkey('new-key')}>set key</button>;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

function readState() {
  return JSON.parse(screen.getByTestId('state').textContent!) as Record<string, unknown>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'getItem');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts unauthenticated with both credential roles empty', () => {
    render(<StateDisplay />, { wrapper });
    expect(readState()).toMatchObject({
      operatorToken: '',
      githubPat: '',
      privkey: null,
      mode: 'api',
      isAuthenticated: false,
    });
  });

  it('authenticates direct GitHub mode only with a GitHub PAT', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton mode="api" githubPat="ghp_direct" />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    expect(readState()).toMatchObject({
      operatorToken: '',
      githubPat: 'ghp_direct',
      mode: 'api',
      isAuthenticated: true,
    });
  });

  it('does not accept an operator token as a GitHub-mode credential', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton mode="api" operatorToken="operator-only" />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    expect(readState()).toMatchObject({
      operatorToken: 'operator-only',
      githubPat: '',
      mode: 'api',
      isAuthenticated: false,
    });
  });

  it('authenticates live mode only with an operator API token', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton mode="live" operatorToken="operator-live" githubPat="ghp_fallback" />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    expect(readState()).toMatchObject({
      operatorToken: 'operator-live',
      githubPat: 'ghp_fallback',
      mode: 'live',
      isAuthenticated: true,
    });
  });

  it('does not accept a GitHub PAT as a live controller credential', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton mode="live" githubPat="ghp_only" />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    expect(readState()).toMatchObject({
      operatorToken: '',
      githubPat: 'ghp_only',
      mode: 'live',
      isAuthenticated: false,
    });
  });

  it('keeps all credentials in memory and clears them on logout', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton
          mode="live"
          operatorToken="operator-secret"
          githubPat="ghp_secret"
          privkey="private-secret"
        />
        <LogoutButton />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    await act(async () => screen.getByText('logout').click());
    expect(readState()).toMatchObject({
      operatorToken: '',
      githubPat: '',
      privkey: null,
      mode: 'offline',
      isAuthenticated: false,
    });
  });

  it('updates the private key without changing either credential role', async () => {
    render(
      <>
        <StateDisplay />
        <LoginButton mode="live" operatorToken="operator-live" githubPat="ghp_direct" />
        <SetPrivkeyButton />
      </>,
      { wrapper },
    );
    await act(async () => screen.getByText('login').click());
    await act(async () => screen.getByText('set key').click());
    expect(readState()).toMatchObject({
      operatorToken: 'operator-live',
      githubPat: 'ghp_direct',
      privkey: '[SET]',
    });
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  });

  it('throws outside AuthProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<StateDisplay />)).toThrow('useAuth must be used within AuthProvider');
    spy.mockRestore();
  });
});
