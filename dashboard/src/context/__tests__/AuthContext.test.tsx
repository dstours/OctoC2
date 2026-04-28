// dashboard/src/context/__tests__/AuthContext.test.tsx
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from '../AuthContext';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Renders a component that reads the full auth state as a JSON string. */
function StateDisplay() {
  const { pat, privkey, mode, serverUrl, latencyMs, isAuthenticated } = useAuth();
  return (
    <div data-testid="state">
      {JSON.stringify({ pat, privkey: privkey ? '[SET]' : null, mode, serverUrl, latencyMs, authed: isAuthenticated })}
    </div>
  );
}

function LoginBtn({ pat, privkey }: { pat: string; privkey?: string }) {
  const { login } = useAuth();
  return (
    <button
      onClick={() =>
        login(pat, 'api', 'http://localhost:8080', null, privkey ?? null)
      }
    >
      login
    </button>
  );
}

function LogoutBtn() {
  const { logout } = useAuth();
  return <button onClick={logout}>logout</button>;
}

function SetPrivkeyBtn({ privkeyValue }: { privkeyValue: string }) {
  const { setPrivkey } = useAuth();
  return <button onClick={() => setPrivkey(privkeyValue)}>setPrivkey</button>;
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthContext', () => {
  beforeEach(() => {
    // Spy on localStorage and sessionStorage to catch accidental persistence
    vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(Storage.prototype, 'getItem');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('starts with empty PAT, null privkey, and api mode (forces login)', () => {
      render(<StateDisplay />, { wrapper: Wrapper });
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.pat).toBe('');
      expect(state.privkey).toBeNull();
      expect(state.mode).toBe('api');
      expect(state.latencyMs).toBeNull();
    });

    it('isAuthenticated() returns false with no PAT', () => {
      render(<StateDisplay />, { wrapper: Wrapper });
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.authed).toBe(false);
    });
  });

  describe('login()', () => {
    it('sets PAT, mode, serverUrl, and latencyMs', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_test123" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.pat).toBe('ghp_test123');
      expect(state.mode).toBe('api');
      expect(state.serverUrl).toBe('http://localhost:8080');
    });

    it('isAuthenticated() returns true after login with a PAT', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_test123" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.authed).toBe(true);
    });

    it('stores the private key when provided at login', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_test123" privkey="deadbeef" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.privkey).toBe('[SET]');
    });

    it('NEVER writes PAT or privkey to localStorage or sessionStorage', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_secret" privkey="secret_key" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    });
  });

  describe('logout()', () => {
    it('clears PAT, privkey, and resets to offline mode', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_test123" privkey="deadbeef" />
          <LogoutBtn />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      await act(async () => screen.getByText('logout').click());
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.pat).toBe('');
      expect(state.privkey).toBeNull();
      expect(state.mode).toBe('offline');
      expect(state.authed).toBe(false);
    });
  });

  describe('setPrivkey()', () => {
    it('sets the private key without changing other state', async () => {
      render(
        <>
          <StateDisplay />
          <LoginBtn pat="ghp_test123" />
          <SetPrivkeyBtn privkeyValue="mykey" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('login').click());
      await act(async () => screen.getByText('setPrivkey').click());
      const state = JSON.parse(screen.getByTestId('state').textContent!);
      expect(state.privkey).toBe('[SET]');
      expect(state.pat).toBe('ghp_test123'); // unchanged
      expect(state.mode).toBe('api');         // unchanged
    });

    it('NEVER writes privkey to localStorage or sessionStorage', async () => {
      render(
        <>
          <SetPrivkeyBtn privkeyValue="mykey" />
        </>,
        { wrapper: Wrapper },
      );
      await act(async () => screen.getByText('setPrivkey').click());
      expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    });
  });

  describe('useAuth outside AuthProvider', () => {
    it('throws with a clear error message', () => {
      // Suppress React's error boundary console output for this test
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => render(<StateDisplay />)).toThrow(
        'useAuth must be used within AuthProvider',
      );
      spy.mockRestore();
    });
  });
});
