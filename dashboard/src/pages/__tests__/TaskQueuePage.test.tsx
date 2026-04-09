// dashboard/src/pages/__tests__/TaskQueuePage.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskQueuePage } from '../TaskQueuePage';
import type { Beacon } from '@/types';
import type { ServerTask } from '@/lib/C2ServerClient';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockMode      = vi.hoisted(() => ({ value: 'live' as string }));
const mockGetBeacons = vi.hoisted(() => vi.fn());
const mockGetResults = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat: 'ghp_test', mode: mockMode.value,
    serverUrl: 'http://localhost:8080',
  }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getBeacons'] = mockGetBeacons;
    this['getResults'] = mockGetResults;
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
}

const BEACON: Beacon = {
  id: 'b1', hostname: 'WIN-HOST', os: 'windows', arch: 'x64',
  status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
};

const PENDING_TASK: ServerTask = {
  taskId: 'tid-1', beaconId: 'b1', kind: 'shell', args: { cmd: 'whoami' },
  status: 'pending', ref: 'abc', createdAt: new Date().toISOString(),
  deliveredAt: null, completedAt: null, result: null,
};

const DELIVERED_TASK: ServerTask = {
  taskId: 'tid-2', beaconId: 'b1', kind: 'ping', args: {},
  status: 'delivered', ref: 'def', createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(), completedAt: null, result: null,
};

const COMPLETED_TASK: ServerTask = {
  taskId: 'tid-3', beaconId: 'b1', kind: 'shell', args: { cmd: 'id' },
  status: 'completed', ref: 'ghi', createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  result: { success: true, output: 'root\n', data: '', signature: '' },
};

beforeEach(() => {
  mockMode.value = 'live';
  mockGetBeacons.mockReset();
  mockGetResults.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TaskQueuePage', () => {
  it('renders the Task Queue heading', async () => {
    mockGetBeacons.mockResolvedValue([]);
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/task queue/i)).toBeInTheDocument();
  });

  it('shows "Live mode required" when mode is api', async () => {
    mockMode.value = 'api';
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    expect(screen.getByText(/live mode required/i)).toBeInTheDocument();
  });

  it('shows "Live mode required" when mode is offline', async () => {
    mockMode.value = 'offline';
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    expect(screen.getByText(/live mode required/i)).toBeInTheDocument();
  });

  it('shows "No active beacons" when beacons array is empty', async () => {
    mockGetBeacons.mockResolvedValue([]);
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/no active beacons/i)).toBeInTheDocument();
  });

  it('renders a beacon section for a beacon with pending tasks', async () => {
    mockGetBeacons.mockResolvedValue([BEACON]);
    mockGetResults.mockResolvedValue([PENDING_TASK]);
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('beacon-tasks-b1')).toBeInTheDocument();
  });

  it('shows pending and delivered tasks but not completed tasks', async () => {
    mockGetBeacons.mockResolvedValue([BEACON]);
    mockGetResults.mockResolvedValue([PENDING_TASK, DELIVERED_TASK, COMPLETED_TASK]);
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    // Section renders because at least one active task exists
    await screen.findByTestId('beacon-tasks-b1');
    expect(screen.getByTestId('task-row-tid-1')).toBeInTheDocument();  // pending
    expect(screen.getByTestId('task-row-tid-2')).toBeInTheDocument();  // delivered
    expect(screen.queryByTestId('task-row-tid-3')).not.toBeInTheDocument(); // completed hidden
  });

  it('hides the beacon section when all tasks are completed', async () => {
    mockGetBeacons.mockResolvedValue([BEACON]);
    mockGetResults.mockResolvedValue([COMPLETED_TASK]);
    render(<TaskQueuePage />, { wrapper: makeWrapper() });
    // Section should not appear — no pending/delivered tasks
    await screen.findByText(/no active beacons|task queue/i);
    expect(screen.queryByTestId('beacon-tasks-b1')).not.toBeInTheDocument();
  });
});
