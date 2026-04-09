// dashboard/src/pages/__tests__/LoginPage.test.tsx
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectionMode } from '@/types';
import { LoginPage } from '../LoginPage';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockLogin     = vi.fn();
const mockNavigate  = vi.fn();
const mockRefresh   = vi.fn().mockResolvedValue(undefined);
const mockConnMode  = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('@/hooks/useConnectionMode', () => ({
  useConnectionMode: (pat: string) => mockConnMode(pat),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeConn(overrides: Partial<{
  mode: ConnectionMode;
  latencyMs: number | null;
  serverUrl: string;
  loading: boolean;
  error: string | null;
}> = {}) {
  return {
    mode:      'offline' as ConnectionMode,
    latencyMs: null as number | null,
    serverUrl: 'http://localhost:8080',
    loading:   false,
    error:     null as string | null,
    refresh:   mockRefresh,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockLogin.mockReset();
  mockNavigate.mockReset();
  mockRefresh.mockReset().mockResolvedValue({ mode: 'api' as ConnectionMode, latencyMs: null });
  // Default: derive mode from PAT length (mirrors production fallback behaviour)
  mockConnMode.mockImplementation((pat: string) =>
    makeConn({ mode: pat.length > 0 ? 'api' : 'offline' }),
  );
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LoginPage', () => {
  // ── Rendering ───────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('has an sr-only OctoC2 heading for accessibility', () => {
      renderPage();
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveClass('sr-only');
      expect(heading).toHaveTextContent('OctoC2');
    });

    it('renders a PAT input of type password', () => {
      renderPage();
      const input = screen.getByPlaceholderText('ghp_...');
      expect(input).toHaveAttribute('type', 'password');
    });

    it('renders the Connect button', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeInTheDocument();
    });

    it('renders the Skip to Offline Mode button', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /skip.*offline/i })).toBeInTheDocument();
    });

    it('renders the Advanced toggle button', () => {
      renderPage();
      expect(screen.getByRole('button', { name: /advanced/i })).toBeInTheDocument();
    });

    it('private key input is hidden by default (collapsed)', () => {
      renderPage();
      expect(screen.queryByPlaceholderText(/private key/i)).not.toBeInTheDocument();
    });
  });

  // ── Mode indicator ───────────────────────────────────────────────────────────

  describe('mode indicator', () => {
    it('shows Offline mode when PAT field is empty', () => {
      renderPage();
      // exact match avoids collision with the "Skip to Offline Mode" button
      expect(screen.getByText('Offline mode')).toBeInTheDocument();
    });

    it('shows API mode when PAT is entered', () => {
      renderPage();
      fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
        target: { value: 'ghp_test123' },
      });
      expect(screen.getByText(/api mode/i)).toBeInTheDocument();
    });

    it('shows Live server text and latency in live mode', () => {
      mockConnMode.mockReturnValue(makeConn({ mode: 'live', latencyMs: 42 }));
      renderPage();
      expect(screen.getByText(/live server.*42ms/i)).toBeInTheDocument();
    });

    it('shows Detecting… when loading', () => {
      mockConnMode.mockReturnValue(makeConn({ loading: true }));
      renderPage();
      // appears in mode indicator (not the button, which is tested separately)
      expect(screen.getAllByText(/detecting/i).length).toBeGreaterThan(0);
    });

    it('shows the error string when probe returns an error', () => {
      mockConnMode.mockReturnValue(
        makeConn({ error: 'Server unreachable', mode: 'offline' }),
      );
      renderPage();
      expect(screen.getByText(/server unreachable/i)).toBeInTheDocument();
    });
  });

  // ── Advanced section ─────────────────────────────────────────────────────────

  describe('advanced section', () => {
    it('shows private key input after toggle is clicked', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
      expect(screen.getByPlaceholderText(/private key/i)).toBeInTheDocument();
    });

    it('hides private key input when toggle is clicked a second time', () => {
      renderPage();
      const toggle = screen.getByRole('button', { name: /advanced/i });
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(screen.queryByPlaceholderText(/private key/i)).not.toBeInTheDocument();
    });

    it('private key input is of type password', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
      expect(screen.getByPlaceholderText(/private key/i)).toHaveAttribute('type', 'password');
    });
  });

  // ── Connect button ───────────────────────────────────────────────────────────

  describe('Connect button', () => {
    it('calls login() with PAT, mode, serverUrl, and latencyMs', async () => {
      renderPage();
      fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
        target: { value: 'ghp_abc' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
      });
      expect(mockLogin).toHaveBeenCalledWith(
        'ghp_abc', 'api', 'http://localhost:8080', null, null,
      );
    });

    it('passes privkey to login() when advanced key input is filled', async () => {
      renderPage();
      fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
        target: { value: 'ghp_abc' },
      });
      fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
      fireEvent.change(screen.getByPlaceholderText(/private key/i), {
        target: { value: 'my-secret-key' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
      });
      expect(mockLogin).toHaveBeenCalledWith(
        'ghp_abc', 'api', 'http://localhost:8080', null, 'my-secret-key',
      );
    });

    it('passes null privkey when advanced key input is empty', async () => {
      renderPage();
      fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
        target: { value: 'ghp_abc' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
      });
      expect(mockLogin).toHaveBeenCalledWith(
        'ghp_abc', 'api', 'http://localhost:8080', null, null,
      );
    });

    it('navigates to "/" after connect', async () => {
      renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
      });
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('is disabled and shows Detecting… text when loading', () => {
      mockConnMode.mockReturnValue(makeConn({ loading: true }));
      renderPage();
      const btn = screen.getByRole('button', { name: /detecting/i });
      expect(btn).toBeDisabled();
    });

    it('calls login() with the mode returned by refresh(), not the stale hook state', async () => {
      // Hook state is stuck at 'offline' (simulates stale read before re-render)
      mockConnMode.mockReturnValue(makeConn({ mode: 'offline', latencyMs: null }));
      // But refresh() detects 'live' with 99ms latency
      mockRefresh.mockResolvedValueOnce({ mode: 'live', latencyMs: 99 });

      renderPage();
      fireEvent.change(screen.getByPlaceholderText('ghp_...'), {
        target: { value: 'ghp_live' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
      });

      // Must use the refresh() return value ('live'), not stale hook state ('offline')
      expect(mockLogin).toHaveBeenCalledWith(
        'ghp_live', 'live', 'http://localhost:8080', 99, null,
      );
    });
  });

  // ── Skip to Offline Mode ─────────────────────────────────────────────────────

  describe('Skip to Offline Mode', () => {
    it('calls login() with empty PAT and offline mode', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /skip.*offline/i }));
      expect(mockLogin).toHaveBeenCalledWith(
        '', 'offline', 'http://localhost:8080', null, null,
      );
    });

    it('navigates to "/" after skipping', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: /skip.*offline/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });
});
