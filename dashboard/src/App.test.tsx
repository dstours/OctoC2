// dashboard/src/App.test.tsx
/**
 * App routing integration tests.
 *
 * Tests the routing guard (ProtectedRoutes) and top-level route layout.
 * Pages are stubbed so tests are fast and focused on routing behaviour only.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionMode } from '@/types';
import { AppRoutes } from './App';

// ── Mocks ──────────────────────────────────────────────────────────────────────

let mockAuthPat  = '';
let mockAuthMode: ConnectionMode = 'offline';

vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    pat:             mockAuthPat,
    mode:            mockAuthMode,
    serverUrl:       'http://localhost:8080',
    latencyMs:       null,
    privkey:         null,
    isAuthenticated: mockAuthPat.length > 0,
    login:           vi.fn(),
    setPrivkey:      vi.fn(),
    logout:          vi.fn(),
  }),
}));

// Stub pages so the routing tests don't render heavy components
vi.mock('@/pages/LoginPage', () => ({
  LoginPage: () => <div data-testid="login-page">Login</div>,
}));
vi.mock('@/pages/BeaconListPage', () => ({
  BeaconListPage: () => <div data-testid="beacon-list-page">Beacons</div>,
}));
vi.mock('@/pages/BeaconDetailPage', () => ({
  BeaconDetailPage: () => <div data-testid="beacon-detail-page">Beacon Detail</div>,
}));
vi.mock('@/pages/TentacleMonitorPage', () => ({
  TentacleMonitorPage: () => <div data-testid="tentacle-monitor-page">Tentacle Monitor</div>,
}));
vi.mock('@/pages/TaskQueuePage', () => ({
  TaskQueuePage: () => <div data-testid="task-queue-page">Task Queue</div>,
}));
vi.mock('@/pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page">Settings</div>,
}));

// Layout must render Outlet so child routes are visible
vi.mock('@/components/Layout', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    Layout: () => (
      <div data-testid="layout">
        <Outlet />
      </div>
    ),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderApp(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockAuthPat  = '';
  mockAuthMode = 'offline';
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('App routing', () => {
  describe('/login route', () => {
    it('renders LoginPage at /login', () => {
      renderApp('/login');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  describe('protected routes', () => {
    it('redirects to /login when unauthenticated and mode is not offline', () => {
      mockAuthPat  = '';
      mockAuthMode = 'api'; // api mode + no PAT → force login
      renderApp('/');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });

    it('allows access in offline mode even without a PAT', () => {
      mockAuthPat  = '';
      mockAuthMode = 'offline';
      renderApp('/');
      expect(screen.getByTestId('beacon-list-page')).toBeInTheDocument();
    });

    it('allows access with a valid PAT in api mode', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/');
      expect(screen.getByTestId('beacon-list-page')).toBeInTheDocument();
    });

    it('wraps protected routes in the Layout shell', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/');
      expect(screen.getByTestId('layout')).toBeInTheDocument();
    });
  });

  describe('unknown routes', () => {
    it('redirects unknown path to /login', () => {
      mockAuthPat  = '';
      mockAuthMode = 'api';
      renderApp('/some/unknown/path');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  describe('page routes', () => {
    it('renders BeaconDetailPage at /beacon/:id', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/beacon/beacon-42');
      expect(screen.getByTestId('beacon-detail-page')).toBeInTheDocument();
    });

    it('renders TentacleMonitorPage at /tentacles', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/tentacles');
      expect(screen.getByTestId('tentacle-monitor-page')).toBeInTheDocument();
    });

    it('renders TaskQueuePage at /tasks', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/tasks');
      expect(screen.getByTestId('task-queue-page')).toBeInTheDocument();
    });

    it('renders SettingsPage at /settings', () => {
      mockAuthPat  = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/settings');
      expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    });
  });
});
