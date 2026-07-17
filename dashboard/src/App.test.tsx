// dashboard/src/App.test.tsx
/**
 * App routing integration tests.
 *
 * Tests the routing guard (ProtectedRoutes) and top-level route layout.
 * Pages are stubbed so tests are fast and focused on routing behaviour only.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionMode } from '@/types';
import * as AuthContextModule from '@/context/AuthContext';
import * as LoginPageModule from '@/pages/LoginPage';
import * as BeaconListPageModule from '@/pages/BeaconListPage';
import * as BeaconDetailPageModule from '@/pages/BeaconDetailPage';
import * as TentacleMonitorPageModule from '@/pages/TentacleMonitorPage';
import * as TaskQueuePageModule from '@/pages/TaskQueuePage';
import * as SettingsPageModule from '@/pages/SettingsPage';
import * as LayoutModule from '@/components/Layout';
import { restoreModuleMocks } from '@/test/moduleMocks';
import { AppRoutes } from './App';

// ── Mocks ──────────────────────────────────────────────────────────────────────

let mockGitHubPat = '';
let mockOperatorToken = '';
let mockAuthMode: ConnectionMode = 'offline';

restoreModuleMocks([
  ['@/context/AuthContext', { ...AuthContextModule }],
  ['@/pages/LoginPage', { ...LoginPageModule }],
  ['@/pages/BeaconListPage', { ...BeaconListPageModule }],
  ['@/pages/BeaconDetailPage', { ...BeaconDetailPageModule }],
  ['@/pages/TentacleMonitorPage', { ...TentacleMonitorPageModule }],
  ['@/pages/TaskQueuePage', { ...TaskQueuePageModule }],
  ['@/pages/SettingsPage', { ...SettingsPageModule }],
  ['@/components/Layout', { ...LayoutModule }],
]);

vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    githubPat:       mockGitHubPat,
    operatorToken:   mockOperatorToken,
    mode:            mockAuthMode,
    serverUrl:       'https://localhost:8080',
    latencyMs:       null,
    privkey:         null,
    isAuthenticated:
      mockAuthMode === 'live'
        ? mockOperatorToken.length > 0
        : mockAuthMode === 'api'
          ? mockGitHubPat.length > 0
          : false,
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
vi.mock('@/components/Layout', () => ({
  Layout: () => (
    <div data-testid="layout">
      <Outlet />
    </div>
  ),
}));

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
  mockGitHubPat = '';
  mockOperatorToken = '';
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
      mockGitHubPat = '';
      mockAuthMode = 'api'; // api mode + no PAT → force login
      renderApp('/');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });

    it('allows access in offline mode even without a PAT', () => {
      mockGitHubPat = '';
      mockAuthMode = 'offline';
      renderApp('/');
      expect(screen.getByTestId('beacon-list-page')).toBeInTheDocument();
    });

    it('allows access with a valid PAT in api mode', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/');
      expect(screen.getByTestId('beacon-list-page')).toBeInTheDocument();
    });

    it('wraps protected routes in the Layout shell', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/');
      expect(screen.getByTestId('layout')).toBeInTheDocument();
    });
  });

  describe('unknown routes', () => {
    it('redirects unknown path to /login', () => {
      mockGitHubPat = '';
      mockAuthMode = 'api';
      renderApp('/some/unknown/path');
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
    });
  });

  describe('page routes', () => {
    it('renders BeaconDetailPage at /beacon/:id', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/beacon/beacon-42');
      expect(screen.getByTestId('beacon-detail-page')).toBeInTheDocument();
    });

    it('renders TentacleMonitorPage at /tentacles', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/tentacles');
      expect(screen.getByTestId('tentacle-monitor-page')).toBeInTheDocument();
    });

    it('renders TaskQueuePage at /tasks', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/tasks');
      expect(screen.getByTestId('task-queue-page')).toBeInTheDocument();
    });

    it('renders SettingsPage at /settings', () => {
      mockGitHubPat = 'ghp_testtoken';
      mockAuthMode = 'api';
      renderApp('/settings');
      expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    });
  });
});
